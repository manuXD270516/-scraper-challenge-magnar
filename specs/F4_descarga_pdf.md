# F4 · Descarga de PDF (resolución + validación + naming)

**Cubre:** R-04 (dueño), R-05 (dueño). Ancla: doc 01 §D-4, ABIERTO-2 (CERRADO en Fase 0).
**Módulos:** `src/scraper/pdf.ts` (envuelto en la política de retry de F5).
**Fixtures:** `test/fixtures/servlet-descarga-sample.pdf` (`%PDF-1.4`, 348 KB).

## Propósito
Descargar el PDF de cada documento con la sesión viva, validarlo (magic bytes + tamaño),
nombrarlo de forma descriptiva/segura/única, y ser idempotente (no re-descargar lo ya válido).

## Mecánica (confirmada en Fase 0)
- `GET /jurisprudenciaweb/ServletDescarga?uuid=<UUID>` → `Content-Type: application/octet-stream`,
  cuerpo `%PDF`. Es un GET simple con el uuid del documento; requiere las cookies de sesión.

## Entradas / salidas (tipadas)
```ts
interface PdfDownloader {
  /** Descarga a output/pdfs/ con naming descriptivo; skip si ya existe y es válido. */
  descargar(doc: Documento): Promise<ResultadoDescarga>;
}
type ResultadoDescarga =
  | { estado: 'ok'; ruta: string; bytes: number }
  | { estado: 'skip'; ruta: string }               // idempotencia
  | { estado: 'fallo'; motivo: string };           // va al ledger (F6)
```

## Naming (R-05)
- Patrón: `slug(expediente)_slug(organo)_<fecha|uuidCorto>.pdf`.
- `slug`: minúsculas, `[a-z0-9-]`, acentos plegados, espacios→`-`, colapso de `-`, recorte a
  ~120 chars. Campos ausentes se omiten sin dejar `__`.
- Colisión de nombre → sufijo `-2`, `-3`, … (nunca sobreescribe otro doc).
- Fallback si no hay metadatos utilizables → `documento_<uuid>.pdf` (nunca `download(3).pdf`).

## Criterios de aceptación (Given/When/Then)
1. **Valida magic bytes (R-04).**
   Given un cuerpo que empieza con `%PDF` y bytes>0 · When se descarga · Then `estado:'ok'`.
   Given un cuerpo sin `%PDF` (p. ej. HTML de error) · Then `estado:'fallo'` con motivo
   `not-a-pdf`, y NO se deja el archivo corrupto en disco.
2. **Naming descriptivo y seguro (R-05).**
   Given `expediente='00123-2024', organo='Sala Civil Permanente', fecha='2024-08-10'` · When
   se nombra · Then `00123-2024_sala-civil-permanente_2024-08-10.pdf` (sin caracteres inseguros).
3. **Dedupe por colisión.**
   Given dos docs que producen el mismo nombre base · When se descargan ambos · Then el segundo
   recibe sufijo `-2`; ambos archivos coexisten.
4. **Idempotencia (contribuye R-12).**
   Given un PDF ya en disco válido (magic bytes + tamaño>0) para ese doc · When se re-descarga
   · Then `estado:'skip'` sin request de red.
5. **Escritura atómica.**
   Given una descarga en curso · When se interrumpe · Then no queda un `.pdf` a medias con
   nombre final (se escribe a `.part` y se renombra al validar).
6. **Descarga bajo política de retry (integración F5).**
   Given un 429 en la descarga · When ocurre · Then se aplica `retryWithBackoff`; agotado,
   `estado:'fallo'` motivo `429-exhausted` y el lote continúa (R-09).

## Edge cases
- Respuesta 200 pero cuerpo HTML (sesión caída) → tratado como `not-a-pdf`, va al ledger.
- Disco lleno al escribir → error tipado `DiskWriteFailed`, doc al ledger (no crash del lote).
- `Content-Length` presente pero cuerpo truncado → tamaño ≠ esperado → `fallo` `truncated`.

## Notas de test
Naming y validación de magic bytes se prueban sin red (la fixture PDF real valida el happy path
y un HTML de error valida el rechazo). La ruta de red se prueba con transporte fake (F5).
