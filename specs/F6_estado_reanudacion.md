# F6 · Estado, ledger y reanudación

**Cubre:** R-10 (dueño), R-12 (dueño). Ancla: doc 01 §D-3.
**Módulos:** `src/state/store.ts`.
**Fixtures:** fixtures sintéticas de `state.json` y `failed.json` (creadas en el test).

## Propósito
Persistir el progreso de forma que ninguna interrupción pierda ni duplique trabajo:
checkpoint atómico (`state.json`), ledger append-only de fallidos (`failed.json`), y descarga
idempotente. Comando `retry-failed` que consume solo el ledger.

## Entradas / salidas (tipadas)
```ts
interface EstadoScraper {
  criterio: CriterioBusqueda;
  ultimaPaginaCompletada: number;
  idsProcesados: string[];        // docs con datos extraídos y PDF resuelto (ok o skip)
  contadores: { paginas: number; documentos: number; pdfsOk: number; fallos: number };
  actualizado: string;            // ISO timestamp
}
interface FalloDescarga {
  id: string; url: string; etapa: 'paginacion'|'extract'|'descarga';
  motivo: string; intentos: number; timestamp: string;
}
interface Store {
  cargarEstado(): Promise<EstadoScraper | null>;
  guardarEstado(e: EstadoScraper): Promise<void>;     // atómico (tmp + rename)
  registrarFallo(f: FalloDescarga): Promise<void>;    // append-only, sin duplicar por id+etapa
  leerFallos(): Promise<FalloDescarga[]>;
}
```

## Criterios de aceptación (Given/When/Then)
1. **Escritura atómica del checkpoint (R-12).**
   Given un `state.json` existente · When `guardarEstado()` escribe · Then se escribe a
   `state.json.tmp` y se renombra; una interrupción entre medias nunca deja el `state.json`
   final corrupto (siempre parseable: el viejo o el nuevo, nunca a medias).
2. **Reanudación no repite (R-12).**
   Given `ultimaPaginaCompletada=3` e `idsProcesados=[...]` · When se reanuda · Then la
   paginación arranca en la página 4 y los ids ya procesados se saltan.
3. **Descarga idempotente (R-12).**
   Given un doc cuyo id ∈ `idsProcesados` y cuyo PDF válido está en disco · When se reprocesa
   · Then se hace `skip` (sin red) — coordinado con F4.
4. **Ledger append-only sin duplicar (R-10).**
   Given un fallo ya registrado para `id+etapa` · When se registra otra vez el mismo · Then no
   se duplica la entrada (se actualiza `intentos`/`timestamp`).
5. **`retry-failed` consume solo el ledger (R-10).**
   Given `failed.json` con K entradas · When corre `retry-failed` · Then se reintentan esas K,
   los éxitos salen del ledger, y los que re-fallan quedan con `intentos` incrementado (sin
   duplicar entradas, R-10 + crítica SRE del doc 02 §6).
6. **Idempotencia de re-ejecución global.**
   Given una corrida completada · When se re-ejecuta `scrape` · Then no se repite ningún trabajo
   (0 descargas nuevas, 0 páginas re-pedidas) salvo lo pendiente.

## Edge cases
- `state.json`/`failed.json` inexistentes → arranque limpio (no error).
- JSON corrupto (interrupción antigua antes de `.gitattributes`) → se detecta, se respalda a
  `.corrupt` y se arranca informando (no crash silencioso).
- `retry-failed` sobre ledger vacío → no-op con mensaje.

## Notas de test
Sin red: I/O de archivos en un directorio temporal. La atomicidad se prueba simulando fallo
entre `write(tmp)` y `rename`. Formatos: `documentos.jsonl` (append seguro, diffeable),
`index.csv` regenerado al final.
