# Fase 6 — Revisión adversarial (3 jueces) y reparación

Tres jueces independientes con personas distintas revisaron el repo (evaluador de rúbrica,
SRE de scraping, ingeniero senior TS). Abajo, los hallazgos consolidados (deduplicados) y su
resolución. Severidad: **alta** bloquea; **media** se corrige o se documenta; **baja** opcional.

## Altas (bloqueantes) — todas resueltas

| # | Hallazgo (jueces) | Resolución |
|---|-------------------|------------|
| A1 | Loop infinito posible: el paginator solo comparaba con la página anterior → un ciclo de período ≥2 con `total=null` y `maxPages=null` no terminaba. | `paginator.ts`: se acumulan los ids vistos en un `Set` de toda la corrida; la iteración termina si una página no aporta **ningún id nuevo**. Test de ciclo período 2. |
| A2 | Página de error/login/truncada (200 sin enlaces) se confundía con "fin de resultados" → pérdida silenciosa con exit 0. | `paginator.ts`: `esPaginaResultados()` distingue vacío legítimo de página no-parseable; ésta lanza `PaginaNoParseable` → `run.ts` la registra en el ledger (etapa `paginacion`). |
| A3 | Extractor con `catch {}` silencioso + etapa `extract` del ledger nunca usada → filas corruptas desaparecían. | `extractor.ts`: en fallo de fila el doc se conserva (id + enlace) con el error anotado; `validarDocumento()` reporta campos faltantes; `run.ts` loguea warning y registra etapa `extract` sin descartar el doc. |
| A4 | Circuit breaker OPEN no pausaba el pipeline: fast-fallaba cada doc al ledger (N fallos en vez de una pausa colectiva). | `pipeline.ts`: `ejecutar()` consulta `breaker.msHastaProximoIntento()` y **duerme** el cooldown antes de exec → pausa colectiva real (R-11). |
| A5 | Fallo de paginación (429 agotado, breaker, 403, ViewState) abortaba toda la corrida sin registro. | `run.ts`: el `for await` de paginación va en try/catch; el fallo se registra (etapa `paginacion`) y la corrida se detiene de forma controlada conservando el checkpoint. |
| A6 | ViewExpired en caliente: el replay estaba en `submit` (re-sembraba pero no re-ejecutaba la búsqueda) → shell vacía y abort. | `session.ts` lanza `ViewExpired`; `jsfPageSource.ts` re-ejecuta la **secuencia completa** (init + búsqueda + página), acotado a 2. Spec F1 §7 actualizada. |

## Medias — corregidas

| # | Hallazgo | Resolución |
|---|----------|------------|
| M1 | Predicado "429/5xx" duplicado en 4 sitios. | `esStatusLimitante()` único en `resilience.ts`, reutilizado en `clasificar`/`pipeline`. |
| M2 | `esLimitante` usaba `err.name` (string) + rama muerta. | Usa `instanceof CircuitOpenError`; simplificado. |
| M3 | `Retry-After` válido enorme dormía sin tope. | `RETRY_AFTER_MAX_MS` (5 min) acota el valor. Test. |
| M4 | PDF truncado con `%PDF` pasaba validación. | `pdf.ts` compara `Content-Length` con el tamaño recibido → `truncated`. Test. |
| M5 | Idempotencia por nombre: dos docs con mismos metadatos colisionaban (uno se perdía). | Nombre incluye `__<uuid8>` → único por documento. Test de no-colisión. |
| M6 | `generarIndiceCsv` no defensivo (una línea corrupta abortaba). | Salta líneas no parseables y deduplica por id. |
| M7 | Breaker HALF_OPEN re-abría ante fallo NO limitante. | Solo re-abre si el fallo es limitante; si no, permite otra sonda. Test. |
| M8 | `RateLimiter` solo espaciaba inicios, no serializaba `op`. | La cola encadena también la ejecución de `op` → concurrencia 1 real. Test. |
| M9 | Constantes de política no configurables; README lo afirmaba falsamente. | README corregido (distingue config operativa de constantes de resiliencia). |
| M10 | `--pdf-concurrency` era config muerta. | Flag retirado; concurrencia 1 fija por cortesía (documentado). |

## Bajas — corregidas las de bajo costo

- `PAGE_SIZE` alineado a `21` (valor observado en recon).
- `parseConfig` rechaza valores negativos.
- `--resume` dejó de ser branch especial; `--no-resume` controla.
- Fixture poblada aclarada como **sintética** en el README.

## No cambiadas (aceptadas, documentadas)

- **`documentos.jsonl` no es atómico** (append): un kill -9 a mitad de append puede dejar una
  línea parcial. Mitigado: `generarIndiceCsv` la salta y deduplica por id; la idempotencia de
  descarga (PDF en disco) evita re-trabajo. Hacer el JSONL 100% atómico se descartó por
  complejidad frente al beneficio (el CSV final ya es robusto). Declarado como límite conocido.
- **`idsProcesados` incluye docs con descarga fallida** (van al ledger y se saltan en
  `scrape --resume`; se recuperan con `retry-failed`). Es coherente con el diseño de ledger.

## Estado del gate G6
Cero hallazgos de severidad alta pendientes; medios resueltos; bajos de bajo costo resueltos.
Suite: **99 tests verdes**, build y lint limpios. Pendiente: re-corrida de los 3 jueces para
confirmar (ciclo 2).
