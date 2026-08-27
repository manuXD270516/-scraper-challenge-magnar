/**
 * http/resilience.ts — Backoff (429/5xx/red), CircuitBreaker global y RateLimiter.
 * Piezas PURAS y componibles: sleep/rng/now se inyectan → tests deterministas sin red.
 * Spec: specs/F5_resiliencia_429.md. Ancla: doc 01 §D-2.
 *
 * Nota de diseño (R-20): esta capa NO conoce JSF ni el dominio jurisprudencia. Solo sabe
 * de resultados de operaciones y de su clasificación de error. Eso la hace testeable en
 * aislamiento y reutilizable.
 */

// ── Errores tipados ──────────────────────────────────────────────────────────
export class RetryExhausted extends Error {
  constructor(
    readonly intentos: number,
    readonly ultimoError: unknown,
  ) {
    super(`Reintentos agotados tras ${intentos} intentos`);
    this.name = 'RetryExhausted';
  }
}

export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker OPEN: el pipeline está en pausa');
    this.name = 'CircuitOpenError';
  }
}

/** Error HTTP con la info que la política de retry necesita clasificar. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    /** Valor crudo del header Retry-After, si vino. */
    readonly retryAfter?: string,
  ) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
  }
}

// ── Clasificación ────────────────────────────────────────────────────────────
export type Clasificacion = 'retry-429' | 'retry-net' | 'no-retry';

/** Clasifica un error para decidir la política. Un 429 se detecta específicamente (R-07). */
export function clasificar(err: unknown): Clasificacion {
  if (err instanceof HttpError) {
    if (err.status === 429) return 'retry-429';
    if (err.status >= 500 && err.status <= 599) return 'retry-net';
    return 'no-retry'; // 4xx≠429: bug nuestro, al ledger.
  }
  // Errores de red/timeout (sin status HTTP) → política corta de red.
  return 'retry-net';
}

// ── Backoff ──────────────────────────────────────────────────────────────────
export interface PoliticaBackoff {
  baseMs: number;
  capMs: number;
  maxAttempts: number;
}

/** Política 429: paciente. Topes por espera: 1000/2000/4000/8000 ms. */
export const POLITICA_429: PoliticaBackoff = { baseMs: 1_000, capMs: 60_000, maxAttempts: 5 };
/** Política 5xx/red: corta. Topes por espera: 1000/2000 ms. */
export const POLITICA_NET: PoliticaBackoff = { baseMs: 1_000, capMs: 60_000, maxAttempts: 3 };

export interface RetryDeps {
  sleep(ms: number): Promise<void>;
  /** ∈ [0,1). */
  rng(): number;
  /** epoch ms. */
  now(): number;
}

/** Tope (antes de jitter) para el reintento n (0-based): min(cap, base·2^n). */
export function topeBackoff(politica: PoliticaBackoff, n: number): number {
  return Math.min(politica.capMs, politica.baseMs * 2 ** n);
}

/** Full jitter: delay(n) = floor(rng() · tope(n)). */
export function delayBackoff(politica: PoliticaBackoff, n: number, rng: () => number): number {
  return Math.floor(rng() * topeBackoff(politica, n));
}

/**
 * Parsea Retry-After (segundos o fecha HTTP). Devuelve ms de espera, o null si es malformado.
 * Ancla F5: si viene y es válido, prevalece sobre el jitter (R-07).
 */
export function parseRetryAfter(raw: string | undefined, nowMs: number): number | null {
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1_000);
  const fecha = Date.parse(trimmed);
  if (!Number.isNaN(fecha)) return Math.max(0, fecha - nowMs);
  return null; // malformado → se ignora, cae al jitter.
}

function politicaPara(clasif: Clasificacion): PoliticaBackoff | null {
  if (clasif === 'retry-429') return POLITICA_429;
  if (clasif === 'retry-net') return POLITICA_NET;
  return null;
}

/**
 * Ejecuta `op` con reintentos según la clasificación del error. No conoce el transporte.
 * - 429 con Retry-After válido → prevalece.
 * - agota → lanza RetryExhausted (el llamador registra en ledger y continúa, R-09).
 */
export async function retryWithBackoff<T>(op: () => Promise<T>, deps: RetryDeps): Promise<T> {
  let ultimoError: unknown;
  // El primer intento es n=0; hay hasta (maxAttempts-1) esperas.
  for (let intento = 0; ; intento++) {
    try {
      return await op();
    } catch (err) {
      ultimoError = err;
      const clasif = clasificar(err);
      const politica = politicaPara(clasif);
      if (politica === null) throw err; // no-retry
      const esperasHechas = intento; // nº de reintento 0-based
      if (esperasHechas >= politica.maxAttempts - 1) {
        throw new RetryExhausted(intento + 1, ultimoError);
      }
      let esperaMs: number;
      const retryAfter =
        err instanceof HttpError ? parseRetryAfter(err.retryAfter, deps.now()) : null;
      if (clasif === 'retry-429' && retryAfter !== null) {
        esperaMs = retryAfter;
      } else {
        esperaMs = delayBackoff(politica, esperasHechas, deps.rng);
      }
      await deps.sleep(esperaMs);
    }
  }
}

// ── Circuit breaker global ───────────────────────────────────────────────────
export type EstadoBreaker = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export interface OpcionesBreaker {
  /** Fallos limitantes consecutivos para abrir. */
  umbralConsecutivo: number;
  /** Tamaño de ventana deslizante. */
  ventana: number;
  /** Fracción de fallos en la ventana para abrir (0..1). */
  umbralFraccion: number;
  cooldownMs: number;
  cooldownMaxMs: number;
}

export const OPCIONES_BREAKER_DEFAULT: OpcionesBreaker = {
  umbralConsecutivo: 5,
  ventana: 20,
  umbralFraccion: 0.5,
  cooldownMs: 120_000,
  cooldownMaxMs: 600_000,
};

/**
 * CircuitBreaker global (no por request): distingue "este doc falla" de "el sitio me limita".
 * Cuando el sitio limita, insistir doc a doc multiplica el castigo; el breaker convierte
 * n reintentos egoístas en una sola pausa colectiva (R-11, razón senior del doc 01 §D-2).
 */
export class CircuitBreaker {
  private estado: EstadoBreaker = 'CLOSED';
  private consecutivos = 0;
  private ventana: boolean[] = []; // true = fallo limitante
  private cooldownActual: number;
  private abiertoDesde = 0;
  private sondaEnCurso = false;

  constructor(
    private readonly opts: OpcionesBreaker = OPCIONES_BREAKER_DEFAULT,
    private readonly now: () => number = Date.now,
  ) {
    this.cooldownActual = opts.cooldownMs;
  }

  get state(): EstadoBreaker {
    return this.estado;
  }

  /** ¿Puede pasar un request ahora? Transiciona OPEN→HALF_OPEN si venció el cooldown. */
  puedePasar(): boolean {
    if (this.estado === 'OPEN') {
      if (this.now() - this.abiertoDesde >= this.cooldownActual) {
        this.estado = 'HALF_OPEN';
        this.sondaEnCurso = false;
      } else {
        return false;
      }
    }
    if (this.estado === 'HALF_OPEN') {
      if (this.sondaEnCurso) return false; // solo 1 sonda a la vez
      this.sondaEnCurso = true;
      return true;
    }
    return true; // CLOSED
  }

  registrarExito(): void {
    if (this.estado === 'HALF_OPEN') {
      this.cerrar();
      return;
    }
    this.consecutivos = 0;
    this.empujarVentana(false);
  }

  /** `limitante` = 429/5xx (cuenta para abrir). 4xx≠429 no limita el circuito. */
  registrarFallo(limitante: boolean): void {
    if (this.estado === 'HALF_OPEN') {
      this.abrir(); // sonda falló → re-abre con cooldown ×2
      return;
    }
    if (!limitante) {
      this.empujarVentana(false);
      return;
    }
    this.consecutivos++;
    this.empujarVentana(true);
    if (this.consecutivos >= this.opts.umbralConsecutivo || this.fraccionSupera()) {
      this.abrir();
    }
  }

  /** Ejecuta `op` a través del breaker; rechaza inmediato si está OPEN. */
  async exec<T>(op: () => Promise<T>, esLimitante: (e: unknown) => boolean): Promise<T> {
    if (!this.puedePasar()) throw new CircuitOpenError();
    try {
      const r = await op();
      this.registrarExito();
      return r;
    } catch (err) {
      this.registrarFallo(esLimitante(err));
      throw err;
    }
  }

  private abrir(): void {
    if (this.estado === 'OPEN') return;
    // Si veníamos de HALF_OPEN (sonda fallida), duplica el cooldown con cap.
    if (this.estado === 'HALF_OPEN') {
      this.cooldownActual = Math.min(this.opts.cooldownMaxMs, this.cooldownActual * 2);
    } else {
      this.cooldownActual = this.opts.cooldownMs;
    }
    this.estado = 'OPEN';
    this.abiertoDesde = this.now();
    this.sondaEnCurso = false;
  }

  private cerrar(): void {
    this.estado = 'CLOSED';
    this.consecutivos = 0;
    this.ventana = [];
    this.cooldownActual = this.opts.cooldownMs;
    this.sondaEnCurso = false;
  }

  private empujarVentana(fallo: boolean): void {
    this.ventana.push(fallo);
    if (this.ventana.length > this.opts.ventana) this.ventana.shift();
  }

  private fraccionSupera(): boolean {
    if (this.ventana.length < this.opts.ventana) return false;
    const fallos = this.ventana.filter(Boolean).length;
    return fallos / this.ventana.length > this.opts.umbralFraccion;
  }
}

// ── Rate limiter propio ──────────────────────────────────────────────────────
/**
 * Espacia requests: intervalo mínimo ± jitter, concurrencia 1 (cortesía, R-16).
 * Serializa las llamadas: cada `schedule` espera su turno y respeta el gap desde la anterior.
 */
export class RateLimiter {
  private ultimoInicio = -Infinity;
  private cola: Promise<void> = Promise.resolve();

  constructor(
    private readonly minIntervalMs: number,
    private readonly jitterRatio: number,
    private readonly deps: RetryDeps,
  ) {}

  private gap(): number {
    const jitter = 1 + (this.deps.rng() * 2 - 1) * this.jitterRatio; // 1 ± ratio
    return Math.max(0, Math.floor(this.minIntervalMs * jitter));
  }

  /** Encola `op` respetando el intervalo mínimo entre inicios (concurrencia 1). */
  async schedule<T>(op: () => Promise<T>): Promise<T> {
    const turno = this.cola.then(async () => {
      const ahora = this.deps.now();
      const espera = this.ultimoInicio + this.gap() - ahora;
      if (espera > 0) await this.deps.sleep(espera);
      this.ultimoInicio = this.deps.now();
    });
    // La cola avanza aunque `op` falle; los errores los ve el llamador.
    this.cola = turno.then(
      () => undefined,
      () => undefined,
    );
    await turno;
    return op();
  }
}

/** Deps de producción. */
export const realDeps: RetryDeps = {
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  rng: Math.random,
  now: Date.now,
};
