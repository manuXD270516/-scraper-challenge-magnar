# F5 · Resiliencia (backoff 429, circuit breaker, rate limiter)

**Cubre:** R-07 (dueño), R-08 (dueño), R-09 (dueño), R-11 (dueño), R-14 (dueño), R-16 (dueño),
R-22 (dueño: tests puros). Ancla: doc 01 §D-2.
**Módulos:** `src/http/resilience.ts` — piezas PURAS, testeables sin red.

## Propósito
Tres piezas ortogonales y componibles que gobiernan la política de errores: reintento con
backoff (429/5xx/red), circuit breaker global (distingue "este doc falla" de "el sitio me
limita") y rate limiter propio (cortesía antes de que el sitio proteste).

## Diseño inyectable (para test determinista)
```ts
interface RetryDeps { sleep(ms: number): Promise<void>; rng(): number; now(): number; }
type Clasificacion = 'retry-429' | 'retry-net' | 'no-retry';
```
`sleep`, `rng` (∈ [0,1)) y `now` se inyectan → los tests son deterministas sin esperar tiempo real.

## Backoff — SECUENCIA EXACTA (fijada por test, R-08)
- **Full jitter:** `delay(n) = floor(rng() * min(cap, base * 2^n))`, `n` = índice de reintento
  (0-based).
- **Política 429 (`retry-429`):** `base=1000ms`, `cap=60000ms`, `maxAttempts=5` (1 intento +
  4 esperas). **Topes por espera:** `n=0→1000`, `n=1→2000`, `n=2→4000`, `n=3→8000` ms.
  - Test con `rng=()=>0` → delays `[0,0,0,0]`. Test con `rng=()=>0.999999` → delays
    `≈[1000,2000,4000,8000]` (asegurar `delay(n) ≤ tope(n)` y `delay(n) < tope(n)+1`).
- **`Retry-After` prevalece (R-07):** si el 429 trae `Retry-After: <segundos>` o `<fecha HTTP>`,
  `delay = max(0, segundos*1000)` o `fecha - now()`, ignorando el cálculo de jitter.
- **Política 5xx/red (`retry-net`):** `base=1000ms`, `cap=60000ms`, `maxAttempts=3`.
  Topes por espera: `n=0→1000`, `n=1→2000` ms.
- **`no-retry`:** 4xx≠429 (bug nuestro) → no reintenta; se propaga para ir al ledger.

## Circuit breaker global (R-11)
- Estados `CLOSED → OPEN → HALF_OPEN → CLOSED`.
- **Abre** al acumular `N=5` fallos limitantes (429/5xx) **consecutivos** o `>50%` en ventana
  de 20 resultados.
- **OPEN**: rechaza de inmediato (pausa TODO el pipeline) durante `cooldown=120000ms`.
- **HALF_OPEN**: deja pasar 1 sonda; éxito → `CLOSED` (resetea contadores); fallo → `OPEN` con
  `cooldown ×2` (cap `600000ms` = 10 min).

## Rate limiter propio (R-16)
- Intervalo mínimo entre requests: `minIntervalMs` (default 2000) `± jitter` (default 50%).
- Concurrencia: `1` en navegación (no configurable a >1 por cortesía); PDFs secuencial por
  defecto (`config.pdfConcurrency`, default 1, máx 2).

## Criterios de aceptación (Given/When/Then)
1. **Detecta 429 específico (R-07).** Given respuesta 429 · When se clasifica · Then
   `retry-429` (no un catch genérico); 500 → `retry-net`; 404 → `no-retry`.
2. **Secuencia de backoff (R-08).** Given `rng=()=>0.999999`, política 429 · When falla 5 veces
   · Then `sleep` fue llamado con `[≈1000, ≈2000, ≈4000, ≈8000]` y a la 5.ª se agota.
3. **Retry-After prevalece (R-07).** Given 429 con `Retry-After: 7` · When se calcula el delay
   · Then `sleep(7000)` exacto, sin jitter.
4. **Agota y continúa (R-09).** Given fallo persistente · When se agotan los intentos · Then la
   función lanza `RetryExhausted` (el llamador lo captura, registra en ledger y sigue con el
   siguiente doc — el lote no muere).
5. **Breaker abre y pausa (R-11).** Given 5 fallos limitantes consecutivos · When ocurre el 5.º
   · Then estado `OPEN` y el siguiente `exec` se rechaza sin llamar al transporte.
6. **Breaker sondea y cierra.** Given `OPEN` + transcurrido `cooldown` · When llega un request
   · Then pasa 1 sonda (`HALF_OPEN`); éxito → `CLOSED`; fallo → `OPEN` con cooldown duplicado
   (cap 10 min).
7. **Rate limiter espacia (R-16).** Given dos `exec` seguidos · When se miden los `now()` · Then
   el segundo no arranca antes de `minIntervalMs` (± jitter) tras el primero.
8. **Timeout y 5xx con su política (R-14).** Given timeout de red · When ocurre · Then se clasifica
   `retry-net` (máx 3), separado de la política 429.

## Edge cases
- `Retry-After` malformado (texto no numérico ni fecha) → se ignora y se cae al jitter (no crash).
- Breaker no puede quedar OPEN para siempre: siempre hay transición HALF_OPEN tras cooldown.
- Reloj no monótono → se usa `now()` inyectable; en prod, `performance.now`/`Date.now` documentado.

## Notas de test
100% unit sin red (nock/msw solo para los tests de integración de F4). `sleep`/`rng`/`now`
inyectados hacen la secuencia de backoff y las transiciones del breaker deterministas.
