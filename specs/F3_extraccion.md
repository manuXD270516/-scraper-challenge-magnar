# F3 · Extracción (HTML → Documento[]) + salida estructurada

**Cubre:** R-02 (dueño), R-06 (dueño), R-15 (dueño), R-18 (dueño: tipos del dominio).
Ancla: doc 01 §D-4, ABIERTO-5.
**Módulos:** `src/scraper/extractor.ts` (función pura), `src/types.ts`.
**Fixtures:** pendiente D-F0-1 `resultado-poblada.html`; hasta entonces fixture sintética.

## Propósito
Transformar el HTML de una página de resultados en `Documento[]` con TODOS los campos
disponibles, con parsing defensivo (HTML feo no revienta el proceso) y validación contra
schema; y serializar la salida estructurada (JSONL + CSV).

## Tipos del dominio (única fuente, R-18)
```ts
interface Documento {
  id: string;                 // uuid del ServletDescarga (clave de dedupe/idempotencia)
  expediente: string | null;
  organo: string | null;      // sala / órgano jurisdiccional
  fecha: string | null;       // ISO yyyy-mm-dd si parseable; si no, texto crudo en fechaTexto
  fechaTexto: string | null;
  tipoResolucion: string | null;
  materia: string | null;
  sumilla: string | null;
  partes: string | null;
  pdfUrl: string | null;      // /jurisprudenciaweb/ServletDescarga?uuid=<id>
  camposExtra: Record<string, string>; // todo campo hallado no mapeado (no perder datos)
}
```
> Los campos exactos se congelan al obtener la fixture poblada; `camposExtra` garantiza que
> ningún dato visible se pierda aunque el mapeo nominal aún no lo contemple (anti-criterio 6).

## Validación (schema)
- Obligatorios: `id` (no vacío). Recomendados: `expediente`, `fecha|fechaTexto`, `pdfUrl`.
- Falta de un recomendado → `warning` + el doc se marca `etapa:'extract'` en el ledger (F6),
  pero se conserva en la salida (fallar defensivamente en batch, ruidosamente en dev).

## Criterios de aceptación (Given/When/Then)
1. **Extrae todos los campos de una fila (R-02).**
   Given una fila de fixture con N campos visibles · When `extraer(html)` · Then el `Documento`
   tiene esos N campos poblados (mapeados o en `camposExtra`); cero campos perdidos.
2. **`id` = uuid del PDF.**
   Given una fila con enlace `ServletDescarga?uuid=X` · When se extrae · Then `id===X` y
   `pdfUrl` termina en `uuid=X`.
3. **Parsing defensivo (R-15).**
   Given HTML con una fila corrupta (celda faltante) · When se extrae · Then esa fila produce
   un `Documento` con nulls + warning, y las demás filas se extraen normalmente (no throw).
4. **Fecha normalizada.**
   Given fecha `dd/mm/yyyy` · When se extrae · Then `fecha` en ISO y `fechaTexto` con el crudo;
   fecha no parseable → `fecha=null`, `fechaTexto` con el crudo (no se inventa).
5. **Serialización JSONL (R-06).**
   Given `Documento[]` · When se serializa · Then una línea JSON por doc, válida, con todas las
   claves del tipo (orden estable).
6. **Índice CSV (R-06).**
   Given la salida JSONL · When se genera el índice · Then `index.csv` con cabecera y una fila
   por doc; campos con comas/comillas escapados según RFC 4180.

## Edge cases
- Tabla de resultados vacía (`formBuscador:panel` vacío, como en `resultado-sin-sesion.html`)
  → `Documento[] === []` sin error (distinto de "error de parsing").
- Celdas con HTML anidado / entidades → texto normalizado (trim, colapso de espacios, entidades
  decodificadas).

## Notas de test
Función pura: entra string HTML, sale `Documento[]`. Sin red, sin I/O. La fixture poblada
(D-F0-1) fija el mapeo definitivo; el test declara explícitamente cuando usa fixture sintética.
