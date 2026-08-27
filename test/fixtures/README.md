# Fixtures de recon (Fase 0)

Estas fixtures son **capturas reales del portal** obtenidas de **Common Crawl**
(archivo web público), **no** del sitio en vivo. Se usan para iterar el parser y las
pruebas **sin tocar** `jurisprudencia.pj.gob.pe` (regla de cortesía del proyecto).

| Archivo | Origen (Common Crawl) | Descripción |
|---|---|---|
| `inicio.html` | CC-MAIN-2025-33, `inicio.xhtml`, 2025-08-08 | Home con `formBuscador` (búsqueda general + especializada). Fuente del catálogo de filtros y de los tokens del POST de búsqueda. |
| `resultado-sin-sesion.html` | CC-MAIN-2024-33, `resultado.xhtml`, 2024-08-10 | Página de resultados obtenida por **GET directo sin búsqueda previa** → shell con `formBuscador:panel` **vacío**. Sirve para el layout base y la extracción de `ViewState`. |
| `servlet-descarga-sample.pdf` | CC-MAIN-2024-51, `ServletDescarga?uuid=1d2b4adf-…`, 2024-12-02 | PDF real de una resolución (`%PDF-1.4`, 348 KB). Fixture para validación de descarga (magic bytes, tamaño). |

## Cómo se obtuvieron (reproducible)
Rango-GET al WARC de Common Crawl usando el índice CDX (`index.commoncrawl.org`) para
localizar `offset`/`length`/`filename`, luego `Range: bytes=offset-end` contra
`data.commoncrawl.org` y descompresión gzip del registro. Scripts en el scratchpad de la
sesión (`fetch_warc*.ps1`, `make_fixtures.ps1`). Cero requests al portal.

## Pendiente (Deuda D-F0-1)
Falta una fixture de **`resultado.xhtml` poblada** (con filas de documentos y paginador)
y una respuesta AJAX RichFaces `<partial-response>`. No existe captura pública de esa
vista (requiere sesión sembrada por búsqueda). Al obtenerla, se añadirá aquí y el
extractor/paginador se validarán contra ella.
