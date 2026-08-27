# Scraper de Jurisprudencia — Poder Judicial del Perú

Scraper en **TypeScript** (sin automatización de navegador) para el portal de
[Jurisprudencia Nacional Sistematizada](https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml)
del Poder Judicial del Perú. Recorre todas las páginas de resultados, extrae la información de
cada documento, descarga los PDFs asociados con nombre descriptivo y **sobrevive al rate
limiting (HTTP 429)** con backoff exponencial + circuit breaker.

> Solo `axios` + `cheerio` (HTTP puro + parsing). **Cero** control de navegador
> (Puppeteer/Playwright/Selenium) — es un requisito del reto.

---

## Requisitos

- Node.js ≥ 20 (probado en 22).
- npm.

## Instalación

```bash
npm install
```

## Uso

```bash
npm run scrape                       # corrida completa (reanuda si hay estado previo)
npm run scrape -- --limit 10 --pages 2   # muestra acotada (cortés con el sitio)
npm run retry-failed                 # reintenta solo los documentos del ledger de fallidos
npm run scrape:dry                   # DEMO offline contra fixtures (no toca el sitio)
npm test                             # tests unitarios (sin red)
npm run build                        # type-check estricto (tsc --noEmit)
```

### Flags (todos opcionales)

| Flag | Env | Default | Descripción |
|------|-----|---------|-------------|
| `--limit N` | `MAX_LIMIT` | ∞ | Máximo de documentos a procesar. |
| `--pages N` | `MAX_PAGES` | ∞ | Máximo de páginas a recorrer. |
| `--out DIR` | `OUT_DIR` | `output` | Carpeta de salida. |
| `--min-interval MS` | `MIN_INTERVAL_MS` | `2000` | Intervalo mínimo entre requests (cortesía). |
| `--timeout MS` | `TIMEOUT_MS` | `30000` | Timeout por request. |
| `--log-level LVL` | `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error`. |
| `--no-resume` | | | Ignora el checkpoint y arranca limpio. |
| `--dry-run` | | | Corre contra fixtures locales (demo/smoke test). |

Precedencia: **CLI > variable de entorno > default**. Los parámetros operativos (delays,
límites, timeouts, salida) viven en [`src/config.ts`](src/config.ts). Las constantes de la
política de resiliencia (topes del backoff, umbrales y cooldown del circuit breaker) son
constantes nombradas en [`src/http/resilience.ts`](src/http/resilience.ts) — no son números
mágicos dispersos, pero tampoco se exponen por CLI (son decisiones de diseño estables). La
descarga es secuencial (concurrencia 1) por cortesía deliberada.

---

## Arquitectura

El scraper de un sitio **JSF (JavaServer Faces)** no es una lista de GETs: es una **conversación
con estado** (cookies `JSESSIONID` + `javax.faces.ViewState` + POSTs de formulario). El diseño
separa esa mecánica de la política de errores, que es donde se juega la calidad.

```
src/
├── config.ts          # configuración única (CLI + env), tipada
├── types.ts           # tipos del dominio (contrato): Documento, EstadoScraper, FalloDescarga…
├── http/
│   ├── client.ts      # axios + cookie jar (tough-cookie) + headers browser-like + timeouts
│   ├── resilience.ts  # backoff+jitter, CircuitBreaker, RateLimiter — PUROS, sin red
│   └── pipeline.ts    # ResilientHttpClient: compone rate limiter → breaker → retry
├── jsf/
│   ├── session.ts     # ciclo de vida JSF: ViewState, ViewExpired → re-siembra + replay
│   └── forms.ts       # construcción de los formularios de búsqueda/paginación
├── scraper/
│   ├── paginator.ts   # itera páginas (PageSource) con doble condición de fin
│   ├── jsfPageSource.ts # PageSource real sobre JsfSession
│   ├── extractor.ts   # HTML → Documento[] (cheerio), anclado al enlace de descarga
│   ├── pdf.ts         # descarga, magic bytes, naming descriptivo, idempotencia
│   └── run.ts         # orquestación (inyectable, testeable offline)
├── state/
│   └── store.ts       # state.json (checkpoint atómico) + failed.json (ledger)
├── logger.ts          # niveles + progreso + resumen final
└── index.ts           # CLI: cablea colaboradores reales
```

**Regla de dependencias:** `scraper/*` usa `http` y `jsf`, nunca al revés. `http/resilience.ts`
no conoce JSF ni el dominio: es reutilizable y se testea en aislamiento.

### Flujo

1. **Siembra de sesión:** GET a `inicio.xhtml` → captura cookies + `ViewState`; POST del
   formulario de búsqueda → primera página de `resultado.xhtml`.
2. **Paginación:** POST JSF por página, renovando el `ViewState` en cada respuesta. Fin por
   **doble condición**: contador total del sitio *o* página vacía/repetida (nunca loop infinito).
3. **Extracción:** cada documento se localiza por su enlace de descarga
   `ServletDescarga?uuid=<UUID>` (el elemento estable), y se cosechan sus campos.
4. **Descarga:** `GET ServletDescarga?uuid=<UUID>` → valida `%PDF`, escribe atómicamente con
   nombre descriptivo, hace *skip* si ya existe (idempotencia).
5. **Estado:** checkpoint por página + ledger de fallidos; re-ejecutar jamás repite trabajo.

---

## Decisiones de diseño

### Manejo de 429 (el corazón del reto)

Tres piezas ortogonales en [`src/http/resilience.ts`](src/http/resilience.ts), todas **puras**
y testeadas sin red:

- **`retryWithBackoff`** — backoff exponencial con **full jitter**:
  `delay(n) = random(0, min(cap, base·2ⁿ))`. Política 429: base 1 s, cap 60 s, máx 5 intentos
  → topes por espera **1000 / 2000 / 4000 / 8000 ms**. Si la respuesta trae `Retry-After`
  (segundos o fecha HTTP), **prevalece** sobre el cálculo. Política separada para 5xx/red
  (más corta, máx 3). Un 4xx≠429 no se reintenta: es bug nuestro, va al ledger.
- **`CircuitBreaker` global** — no por request. Ante una ráfaga de 429/5xx (5 consecutivos o
  >50 % en ventana de 20) abre (`OPEN`) y **pausa todo el pipeline** durante un cooldown; luego
  sondea (`HALF_OPEN`) y cierra (`CLOSED`) o re-abre con cooldown ×2 (cap 10 min). Razón: cuando
  el sitio limita, insistir documento a documento multiplica el castigo; el breaker convierte
  *n* reintentos egoístas en una sola pausa colectiva.
- **`RateLimiter` propio** — intervalo mínimo entre requests (2 s ± jitter) y concurrencia 1.
  Cortesía **antes** de que el sitio proteste. No paralelizar es una decisión, no una carencia.

Los fallos que agotan reintentos **no matan el lote**: van al ledger `failed.json` y la corrida
continúa con el siguiente documento. `npm run retry-failed` los reintenta después.

### Reanudación e idempotencia

- `state.json`: checkpoint atómico (write-tmp + rename) al cerrar cada página.
- `failed.json`: ledger append-only, sin duplicar por `(id, etapa)`.
- Descarga idempotente: si el PDF existe y es válido, se hace *skip* sin tocar la red.
- Re-ejecutar retoma donde quedó; una interrupción a mitad de página se re-visita sin duplicar.

### Naming de PDFs

`slug(expediente)_slug(organo)_fecha__<uuid8>.pdf` (acentos plegados, caracteres seguros,
longitud acotada). El sufijo uuid corto garantiza unicidad por documento: dos resoluciones con
los mismos metadatos no colisionan ni se pisan. Sin metadatos utilizables →
`documento_<uuid>.pdf`. Nunca `download(3).pdf`.

---

## Estructura de salida

```
output/
├── data/
│   ├── documentos.jsonl   # una línea JSON por documento (append seguro, diffeable)
│   └── index.csv          # índice tabular (RFC 4180)
├── pdfs/
│   └── <expediente>_<organo>_<fecha>__<uuid8>.pdf
├── state.json             # checkpoint (gitignored)
└── failed.json            # ledger de fallidos (gitignored)
```

---

## Corrida de muestra (evidencia)

`npm run scrape:dry` ejercita **todo el pipeline** contra fixtures locales (ver
§Limitaciones para el porqué), produciendo artefactos reales:

```
[INFO] DRY-RUN: corriendo contra fixtures locales (no se toca el sitio).
[INFO] página 1 · 3 docs · acumulado: 3 docs, 3 PDF ok, 0 skip, 0 fallos
[INFO] ──────── Resumen de la corrida ────────
[INFO] páginas: 1 · documentos: 3 · PDFs ok: 3 · skip: 0 · fallos: 0
[INFO] Índice CSV generado con 3 documentos.
```

Genera 3 PDFs válidos (`%PDF`, naming descriptivo), `documentos.jsonl` (3 líneas UTF-8),
`index.csv` y `state.json` coherente. Re-ejecutar no duplica ni re-descarga (idempotencia).

---

## Tests

```bash
npm test
```

87 tests unitarios/integración **sin red**: secuencia exacta de backoff, transiciones del
circuit breaker, rate limiter, sesión JSF/ViewState, extracción (con fixtures), naming y
validación de PDFs, checkpoint/ledger, y una corrida end-to-end con colaboradores fake
(incluye 429→ledger→continúa y reanudación sin duplicar).

---

## Limitaciones conocidas

- **Acceso al sitio bloqueado desde la red de desarrollo.** El portal está detrás de un WAF
  (Radware) que devuelve **403 por reputación de IP** desde la red usada para desarrollar
  (no es un problema de headers: ocurre incluso en un navegador real). El sitio *sí* es
  accesible desde otras redes (hay capturas HTTP 200 en Common Crawl de 2024–2025). Por eso:
  - El desarrollo y las pruebas se hacen contra **fixtures** en `test/fixtures/`, sin martillar
    el portal. `inicio.html`, `resultado-sin-sesion.html` y el PDF de muestra son **capturas
    reales** de Common Crawl; la página de resultados **poblada** es una fixture **sintética**
    (marcada `SINTETICA`) construida a partir de la estructura real, porque no existe captura
    pública de esa vista (requiere sesión sembrada). El extractor se ancla al enlace de descarga
    para adaptarse a la estructura real sin reescritura.
  - La **corrida real completa** debe ejecutarse desde una red con acceso; el código está listo
    para ello (`npm run scrape`). La evidencia de arriba es del pipeline contra fixtures.
- **Mecánica de paginación y mapeo de campos:** confirmados parcialmente. La descarga de PDF
  (`ServletDescarga?uuid=<UUID>`) y la necesidad de sembrar sesión están confirmadas; los tokens
  exactos del POST de paginación y los nombres precisos de los campos son hipótesis derivadas del
  formulario real, aisladas en [`src/jsf/forms.ts`](src/jsf/forms.ts) y el extractor (anclado al
  enlace de descarga) para ajustarse sin reescritura al validar contra una página poblada real.

---

## Scraping cortés (consideraciones éticas)

Es un portal público judicial. El scraper aplica delays con jitter (≥2 s), concurrencia 1,
timeouts y un circuit breaker que se aparta cuando el sitio da señales de saturación. El
desarrollo se hizo contra fixtures para no generar carga innecesaria. La velocidad no es el
objetivo: **primero no perder datos, después no castigar al sitio, después ser rápido.**

---

## Preguntas para el equipo

1. El enunciado nombra dos portales distintos (`pje.trf5.jus.br` en el encabezado y
   `jurisprudencia.pj.gob.pe` en el paso de exploración y la entrega). Asumimos el **peruano**
   como objetivo. ¿Correcto?
2. ¿Preferencia de formato de salida (JSON vs CSV) o de estructura de carpetas para los PDFs?
   Default actual: JSONL por documento + índice CSV, PDFs en `output/pdfs/`.
3. ¿Límite de cortesía esperado (requests/minuto) para la corrida de demostración? Default:
   ~30 req/min con jitter.
