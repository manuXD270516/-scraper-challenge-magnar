# F7 · CLI, configuración y logging

**Cubre:** R-17 (dueño), R-21 (dueño: README), R-23 (dueño: entrega), R-24 (dueño: evidencia),
R-19/R-20 (contribuye: cohesión de capas y comentarios). Ancla: doc 01 §1, §D-3.
**Módulos:** `src/config.ts`, `src/logger.ts`, `src/index.ts`.

## Propósito
Punto de entrada CLI que orquesta las capas, configuración única sin números mágicos, y logging
de progreso legible. Es también el dueño documental de la entrega (README, scripts, evidencia).

## Configuración (R-17) — única fuente, tipada
```ts
interface Config {
  baseUrl: string;            // default portal peruano
  outDir: string;             // default 'output'
  timeoutMs: number;          // 30000
  minIntervalMs: number;      // 2000
  jitterRatio: number;        // 0.5
  pdfConcurrency: number;     // 1 (máx 2)
  maxLimit: number | null;    // --limit
  maxPages: number | null;    // --pages
  resume: boolean;            // default true si hay estado
  logLevel: 'debug'|'info'|'warn'|'error';
}
```
- Precedencia: **CLI > env > defaults**. Ningún valor de política enterrado en el código
  (todos viven aquí). Flags: `--limit`, `--pages`, `--out`, `--resume`, `--retry-failed`,
  `--log-level`.

## Comandos
- `scrape` (default): corrida completa; reanuda si hay `state.json`.
- `scrape --limit N --pages K`: muestra acotada (cortesía; es como se toca el sitio).
- `retry-failed`: consume `failed.json` (F6).

## Logging (R-21 evidencia)
- Progreso: `página x/y (ok/fail acumulados)`, cada PDF `ok|skip|fallo`, y **resumen final**:
  páginas, docs, PDFs ok/skip/fallo, duración, y estimación de corrida completa.
- Niveles respetan `logLevel`. Sin secretos ni rutas absolutas personales en logs (anti-crit 7).

## Criterios de aceptación (Given/When/Then)
1. **Precedencia de config (R-17).** Given `env.MIN_INTERVAL_MS=5000` y `--`(sin flag) · Then
   `minIntervalMs=5000`; con `--min-interval 3000` · Then `3000` (CLI gana).
2. **Cero números mágicos.** Given una revisión del código · When se buscan literales de política
   (delays, topes, cooldown) · Then todos referencian `config`/constantes nombradas en F5, no
   literales dispersos.
3. **Flags de acotación llegan a las capas.** Given `--limit 5 --pages 2` · Then el paginator
   recibe `maxPages=2` y el pipeline corta a 5 docs.
4. **Resumen final (R-24).** Given una corrida (real o simulada) · When termina · Then imprime
   el resumen con conteos y duración, en forma pegable al README.
5. **README reproduce (R-21/R-23).** Given una máquina limpia · When se sigue el README
   (`install` → `scrape --limit 3`) · Then funciona sin pasos ocultos (verificado en Fase 7).

## Edge cases
- Flag desconocido → error de uso claro + `exit 1` (no arranque silencioso).
- `--retry-failed` con `scrape` a la vez → error de uso (comandos mutuamente excluyentes).
- SIGINT (Ctrl-C) → cierre limpio: flush del checkpoint antes de salir.

## Notas de test
El parser de config/flags se prueba puro (entra argv+env, sale `Config`). El logging se prueba
capturando el sink. La reproducibilidad del README se verifica en Fase 7 (clone limpio).
