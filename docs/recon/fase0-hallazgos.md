# Fase 0 — Recon del portal (hallazgos)

**Fecha:** 2026-08-27 · **Restricción de cortesía:** cero requests de scraping al sitio.
Todo el recon se hizo con **fuentes de archivo público** (Common Crawl) y sondas mínimas
de conectividad, para no gastar del presupuesto de <300 requests reales ni arriesgar
bloqueo de IP durante el desarrollo. Ver [test/fixtures/README.md](../../test/fixtures/README.md).

## Resumen ejecutivo
El portal es **Mojarra JSF + RichFaces 4.2.2.Final** (Facelets `.xhtml`) detrás de un
**WAF Radware** (`Server: rdwr`) con **Radware Bot Manager** (StormCaster / `perfdrive.com`,
cookies `__uzma/b/c/d/e`). La navegación es una **conversación con estado**
(JSESSIONID sticky + `javax.faces.ViewState` renovado por respuesta), tal como anticipó
el insumo 01. La descarga de PDF quedó **completamente resuelta**. La mecánica exacta de
paginación y el inventario de campos **no pudieron cerrarse con evidencia directa** porque
no existe ninguna captura pública de una página de resultados *poblada* (ver Deudas).

## Hechos verificados

### Stack y sesión
- App server: **Mojarra JSF** + **RichFaces 4.2.2.Final**; vistas Facelets `.xhtml`.
- Nodos backend en cluster: `jvmr-scjurisp3`, `jvmr-scjurisp4` → **sticky session** por
  sufijo de `JSESSIONID` (`...jvmr-scjurisp4`). El scraper debe conservar la cookie
  completa, incluido el sufijo de nodo.
- Cookies: `JSESSIONID` (`Path=/jurisprudenciaweb; Secure; HttpOnly`) + `__uzma..__uzme`
  (Radware Bot Manager). `ViewState` embebido en cada form como
  `<input name="javax.faces.ViewState">` — valor tipo `-3672904194289307332:6709027154229151979`.

### Flujo de búsqueda (siembra de sesión) — ABIERTO-3
- `inicio.xhtml` contiene `formBuscador` (POST `application/x-www-form-urlencoded`).
- **Búsqueda general** (botón lupa): POST con `formBuscador:j_idt31`, `forward=buscar`,
  `busqueda=especializada`, `formBuscador:j_idt34=21`, `...j_idt35=DESC`,
  `...j_idt36=Principal`, `...j_idt37=1`, + `formBuscador:txtBusqueda`, + `ViewState`.
- **Búsqueda especializada** (botón buscar): POST con `formBuscador:j_idt69`,
  `forward=buscar`, `...j_idt71=21`, `...j_idt72=DESC`, `...j_idt73=Principal`,
  `...j_idt74=1`, + campos del panel + `ViewState`.
- **Interpretación de los tokens posicionales:** `21` = registros por página,
  `DESC` = orden, `Principal` = tipo de listado, `1` = **número de página**.
  → Hipótesis fuerte para ABIERTO-1: la paginación se logra **repitiendo el POST de
  búsqueda variando el token de página** (el último `1`), o vía un componente paginador
  RichFaces sobre `formBuscador:panel`. **No confirmable** sin página poblada.
- Un **GET directo** a `resultado.xhtml` (sin búsqueda previa) devuelve la **shell vacía**:
  `<div id="formBuscador:panel"></div>` y `<table id="formBuscador:panealJur">` sin filas.
  → Confirma que `resultado.xhtml` **exige sesión sembrada** por el flujo de búsqueda.

### Descarga de PDF — ABIERTO-2 (CERRADO)
- Endpoint: **`GET /jurisprudenciaweb/ServletDescarga?uuid=<UUID>`**.
- Respuesta: `Content-Type: application/octet-stream`, contenido **`%PDF-1.4`** real.
- Verificado con fixture de Common Crawl (348 KB, magic bytes OK). Es un GET simple con
  un UUID por documento; reproducible con la sesión viva. El UUID proviene del listado.

### Catálogo de filtros (inventario del formulario)
- **Nivel:** Corte Suprema (1) / Corte Superior (2).
- **Especialidad:** Civil, Comercial, Constitucional, Cont. Adm. Laboral, Cont. Adm.
  Previsional, Cont. Administrativo, Familia Civil, Familia Penal, Familia Tutelar,
  Laboral, Penal, Revisión de Proc. Coactivo.
- **Otros:** Distrito Judicial, Órgano Jurisdiccional, Pretensión/Delito (autocomplete),
  Palabras Clave (autocomplete), Nº Expediente, Año, "Incluir autos calificatorios".
- **Años con datos:** 1982, 1998, 1999, 2000–2025.
  → Palanca de partición del universo: **iterar por año** acota lotes y da doble condición
  de fin por segmento (útil para R-03).

### Anti-bot / acceso — ABIERTO-4 y H5
- `Server: rdwr` (Radware AppWall) + Bot Manager (StormCaster JS de `perfdrive.com`).
- **Common Crawl obtuvo HTTP 200** del portal en 2024 y 2025 con un crawler **sin
  ejecución de JS** → **H5 confirmada históricamente**: el contenido NO exige JS; el reto
  es de *acceso/reputación*, no de renderizado.
- **Estado actual (2026-08-27):** **403 total** desde esta máquina —
  IP `181.188.162.37` (Tigo Bolivia)— en **curl con headers Chrome**, en el navegador
  integrado y en **Chrome real**. El WAF responde `403 Forbidden` con `Transaction ID`
  (página Radware), no un challenge JS servible. → El bloqueo actual es por
  **IP/geo/reputación**, no por falta de headers. Ver Riesgo 1 y Deuda D-F0-2.

## Estado de los ABIERTOS tras Fase 0
| ID | Estado | Resolución |
|---|---|---|
| ABIERTO-1 paginación | **PARCIAL** | Hipótesis: POST de búsqueda con token de página (`...=1`→N) o paginador RichFaces sobre `formBuscador:panel`. Sin página poblada no se confirma. Default 01 (POST JSF con ViewState) se mantiene. |
| ABIERTO-2 descarga PDF | **CERRADO** | `GET ServletDescarga?uuid=<UUID>` → `%PDF`. Fixture verificada. |
| ABIERTO-3 universo/siembra | **CERRADO** | `resultado.xhtml` exige sesión sembrada por el flujo de búsqueda desde `inicio.xhtml`. |
| ABIERTO-4 headers mínimos | **BLOQUEADO** | No determinable desde esta IP: 403 total incluso en Chrome real → bloqueo de acceso, no de headers. |
| ABIERTO-5 campos Documento | **PARCIAL** | Sin página de resultados poblada. Default 01 (campos visibles en la lista) hasta obtener fixture real. |
| ABIERTO-6 Retry-After/límites | **ABIERTO** | Solo observable durante corrida real (hoy imposible). Default 01: cooldown 120 s, delay 2 s ± jitter. |

## Riesgos actualizados
1. **Bloqueo de acceso desde esta red (crítico, materializado).** 403 total. El desarrollo
   del parser se hace 100 % contra fixtures (regla de cortesía ya lo exigía). Impacto en
   R-24 (corrida de muestra real) y checkpoint de Fase 5: **requiere decisión del usuario**
   (ver Deuda D-F0-2 y consulta abierta).
2. Sin fixture de resultados poblada → extractor y paginador se diseñan sobre hipótesis;
   deben quedar tras interfaces con tests de contrato para adaptarse al confirmar (Deuda D-F0-1).

## Deudas de Fase 0
- **D-F0-1:** falta fixture de `resultado.xhtml` **poblada** (con filas + paginador) y de una
  respuesta AJAX RichFaces `<partial-response>`. Bloquea confirmar ABIERTO-1 y ABIERTO-5.
- **D-F0-2:** acceso al sitio bloqueado (403) desde esta IP → no hay vía hoy para las
  corridas acotadas reales (`--limit`) que exigen R-07/R-11/R-24 y el checkpoint de Fase 5.
