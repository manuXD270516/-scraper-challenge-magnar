# F2 · Paginación (descubrimiento + iteración + doble fin)

**Cubre:** R-01 (dueño), R-03 (dueño). Ancla: doc 01 §D-1, ABIERTO-1.
**Módulos:** `src/scraper/paginator.ts` (usa `http` + `jsf`, nunca al revés).
**Fixtures:** `test/fixtures/resultado-sin-sesion.html` (+ pendiente D-F0-1: `resultado-poblada.html`,
`partial_pag.xml`).

## Propósito
Sembrar la sesión con una búsqueda (desde `inicio.xhtml`), descubrir el total de documentos,
e iterar TODAS las páginas de resultados vía POST JSF, con doble condición de fin que impide
tanto el loop infinito como el corte prematuro.

## Mecánica (hipótesis anclada, a confirmar con fixture poblada)
- Siembra: `POST inicio.xhtml` con los tokens del `formBuscador` (búsqueda general o
  especializada) + `ViewState` → primera página de `resultado.xhtml`.
- Paginación: repetición del POST variando el **token de página** (último argumento posicional,
  observado `...=1` en el recon) o disparo del componente paginador RichFaces sobre
  `formBuscador:panel` (respuesta `<partial-response>`). El adaptador queda tras interfaz para
  absorber cuál de las dos es (Reversibilidad, 01 §D-1).

## Entradas / salidas (tipadas)
```ts
interface Paginator {
  /** Siembra + devuelve el total declarado por el sitio y la primera página. */
  start(criterio: CriterioBusqueda): Promise<{ total: number; primera: ResultadoPagina }>;
  /** Itera páginas a partir de la primera; async-iterable perezoso. */
  paginas(criterio: CriterioBusqueda): AsyncIterable<ResultadoPagina>;
}
interface ResultadoPagina { numero: number; documentos: Documento[]; haySiguiente: boolean; }
```

## Criterios de aceptación (Given/When/Then)
1. **Descubre total (R-03).**
   Given una primera página con contador total · When `start()` · Then `total` == número del
   contador del sitio (no estimado).
2. **Itera hasta el fin por total.**
   Given `total=N` y `pageSize` conocido · When se consume `paginas()` · Then emite
   `ceil(N/pageSize)` páginas y se detiene (no pide la página vacía siguiente).
3. **Doble condición de fin (R-03).**
   Given una página vacía o idéntica a la anterior (hash de ids) ANTES de alcanzar el total
   esperado · When se detecta · Then la iteración termina y se registra `warning` (posible
   truncamiento del sitio), nunca loop infinito.
4. **Sin corte prematuro.**
   Given `total > pageSize` · When se itera · Then se piden ≥2 páginas (no se corta en la 1).
5. **`--pages k` acota.**
   Given `config.maxPages=k` · When se itera · Then emite exactamente `min(k, ceil(N/pageSize))`
   páginas.
6. **ViewState se propaga entre páginas.**
   Given la página i con ViewState Vi · When se pide la i+1 · Then el POST usa Vi (vía JsfSession),
   no un ViewState viejo.

## Edge cases
- Total ausente/no parseable → se cae a la condición de página vacía/repetida y se loguea.
- Página que repite ids de la anterior (sitio ignoró el avance) → fin + warning, no loop.
- ViewExpired a mitad de la paginación → JsfSession.reset() + reanudar desde la página en curso
  (no desde la 1 si el checkpoint la tiene; ver F6).

## Notas de test
Con fixtures y `JsfSession` fake. La mecánica exacta se fija al obtener `resultado-poblada.html`
(Deuda D-F0-1); hasta entonces los tests usan una fixture sintética mínima marcada como tal.
