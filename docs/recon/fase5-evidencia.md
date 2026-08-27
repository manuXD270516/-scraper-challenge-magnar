# Fase 5 — Evidencia de corrida de muestra (dry-run offline)

La corrida E2E **real** contra el sitio está bloqueada por el 403 desde esta red (deuda
D-F0-2). Por decisión del usuario (desarrollar contra fixtures; diferir la corrida real), la
evidencia de Fase 5 se genera con `npm run scrape:dry`, que ejercita **todo el pipeline**
(paginación → extracción → descarga → validación → estado → índice) contra las fixtures
reales de Common Crawl, **sin tocar el sitio**.

## Comando
```bash
npm run scrape:dry     # = tsx src/index.ts --dry-run
```

## Salida del log
```
[INFO] DRY-RUN: corriendo contra fixtures locales (no se toca el sitio).
[INFO] página 1 · 3 docs · acumulado: 3 docs, 3 PDF ok, 0 skip, 0 fallos
[INFO] ──────── Resumen de la corrida ────────
[INFO] páginas: 1
[INFO] documentos: 3
[INFO] PDFs ok: 3 · skip: 0 · fallos: 0
[INFO] Índice CSV generado con 3 documentos.
```

## Artefactos generados (output/, gitignored)
```
output/data/documentos.jsonl   3 líneas (una por doc, JSON válido, UTF-8 correcto)
output/data/index.csv          cabecera + 3 filas (RFC 4180)
output/state.json              checkpoint: ultimaPaginaCompletada=1, 3 idsProcesados
output/pdfs/00123-2024-0-1801_sala-civil-permanente_2024-08-10__1d2b4adf.pdf   348 KB, %PDF
output/pdfs/00987-2023-5-1801_sala-penal-transitoria_2023-12-03__471af24a.pdf  348 KB, %PDF
output/pdfs/00555-2022-0-0501__537f0204.pdf                                    348 KB, %PDF
```

## Verificaciones (checklist G5)
- ✅ Conteo de docs == esperado (3 en la fixture, contador del sitio leído: "3 resultados").
- ✅ Campos obligatorios poblados; fila con "fecha ilegible" → `fecha=null`, `fechaTexto`
  preservado (parsing defensivo, R-15).
- ✅ PDFs válidos: magic bytes `%PDF`, tamaño > 0.
- ✅ Naming descriptivo y único: `expediente_organo_fecha__<uuid8>.pdf`; el doc sin órgano/fecha
  cae a `expediente__<uuid8>.pdf` (no `download(3).pdf`). El uuid corto garantiza unicidad.
- ✅ `documentos.jsonl` (una línea por doc) + `index.csv` bien formados; UTF-8 correcto
  (verificado leyendo el archivo como UTF-8; el mojibake solo aparece en la consola PS 5.1).
- ✅ `state.json` coherente; re-ejecutar **no duplica** líneas del JSONL ni re-descarga PDFs
  (idempotencia R-12 verificada en vivo: 3 líneas / 3 PDFs tras segunda corrida).
- ✅ Log de progreso legible + resumen final.

## Estimación de corrida completa
No estimable sin el contador real del universo (requiere acceso al sitio). El diseño ya asume
corpus grande: checkpoint por página + descarga idempotente permiten reanudar indefinidamente.
Con delay de cortesía 2 s ± jitter y concurrencia 1, el ritmo es ~1 doc / (2 s navegación +
2 s descarga) ≈ 900 docs/hora en el mejor caso, menos bajo backoff/breaker.

## Limitación declarada (R-24)
Esta es evidencia del pipeline **contra fixtures**, no una corrida contra el sitio en vivo.
La corrida real queda pendiente de ejecutarse desde una red con acceso al portal (ver README
§Limitaciones). Los datos de la muestra provienen de la fixture sintética (D-F0-1) y del PDF
real de Common Crawl.
