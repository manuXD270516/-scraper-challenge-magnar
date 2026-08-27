import { describe, it, expect } from 'vitest';
import {
  clasificar,
  HttpError,
  retryWithBackoff,
  RetryExhausted,
  topeBackoff,
  delayBackoff,
  parseRetryAfter,
  POLITICA_429,
  POLITICA_NET,
  CircuitBreaker,
  CircuitOpenError,
  RateLimiter,
  type RetryDeps,
} from '../src/http/resilience.js';

/** Deps de test: sleep instantáneo que registra los ms; rng y now controlados. */
function fakeDeps(opts?: { rng?: () => number; now?: () => number }): {
  deps: RetryDeps;
  sleeps: number[];
} {
  const sleeps: number[] = [];
  const deps: RetryDeps = {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    rng: opts?.rng ?? (() => 0),
    now: opts?.now ?? (() => 0),
  };
  return { deps, sleeps };
}

describe('clasificación (R-07)', () => {
  it('429 → retry-429; 500 → retry-net; 404 → no-retry; red → retry-net', () => {
    expect(clasificar(new HttpError(429))).toBe('retry-429');
    expect(clasificar(new HttpError(503))).toBe('retry-net');
    expect(clasificar(new HttpError(404))).toBe('no-retry');
    expect(clasificar(new Error('ECONNRESET'))).toBe('retry-net');
  });
});

describe('backoff secuencia exacta (R-08)', () => {
  it('topes 429 = 1000/2000/4000/8000', () => {
    expect([0, 1, 2, 3].map((n) => topeBackoff(POLITICA_429, n))).toEqual([1000, 2000, 4000, 8000]);
  });
  it('rng=0 → delays 0; rng≈1 → delays ≈ tope', () => {
    expect([0, 1, 2, 3].map((n) => delayBackoff(POLITICA_429, n, () => 0))).toEqual([0, 0, 0, 0]);
    const casi = () => 0.999999;
    expect([0, 1, 2, 3].map((n) => delayBackoff(POLITICA_429, n, casi))).toEqual([
      999, 1999, 3999, 7999,
    ]);
  });
  it('cada delay ≤ su tope', () => {
    for (let n = 0; n < 4; n++) {
      expect(delayBackoff(POLITICA_429, n, () => 0.5)).toBeLessThanOrEqual(topeBackoff(POLITICA_429, n));
    }
  });
});

describe('retryWithBackoff (R-08/R-09)', () => {
  it('429 persistente: 5 intentos, 4 esperas [1000,2000,4000,8000], luego RetryExhausted', async () => {
    const { deps, sleeps } = fakeDeps({ rng: () => 0.999999 });
    let intentos = 0;
    await expect(
      retryWithBackoff(async () => {
        intentos++;
        throw new HttpError(429);
      }, deps),
    ).rejects.toBeInstanceOf(RetryExhausted);
    expect(intentos).toBe(5);
    expect(sleeps).toEqual([999, 1999, 3999, 7999]);
  });

  it('éxito tras 2 fallos 429 devuelve el valor', async () => {
    const { deps, sleeps } = fakeDeps();
    let n = 0;
    const r = await retryWithBackoff(async () => {
      if (n++ < 2) throw new HttpError(429);
      return 'ok';
    }, deps);
    expect(r).toBe('ok');
    expect(sleeps.length).toBe(2);
  });

  it('Retry-After prevalece sobre el jitter (R-07)', async () => {
    const { deps, sleeps } = fakeDeps({ rng: () => 0.999999 });
    let n = 0;
    await retryWithBackoff(async () => {
      if (n++ < 1) throw new HttpError(429, '7');
      return 'ok';
    }, deps);
    expect(sleeps).toEqual([7000]); // exacto, sin jitter
  });

  it('5xx usa política corta (máx 3 intentos → 2 esperas)', async () => {
    const { deps, sleeps } = fakeDeps({ rng: () => 0 });
    let intentos = 0;
    await expect(
      retryWithBackoff(async () => {
        intentos++;
        throw new HttpError(500);
      }, deps),
    ).rejects.toBeInstanceOf(RetryExhausted);
    expect(intentos).toBe(POLITICA_NET.maxAttempts);
    expect(sleeps.length).toBe(2);
  });

  it('4xx≠429 no reintenta (no-retry)', async () => {
    const { deps } = fakeDeps();
    let intentos = 0;
    await expect(
      retryWithBackoff(async () => {
        intentos++;
        throw new HttpError(404);
      }, deps),
    ).rejects.toBeInstanceOf(HttpError);
    expect(intentos).toBe(1);
  });
});

describe('parseRetryAfter', () => {
  it('segundos', () => expect(parseRetryAfter('7', 0)).toBe(7000));
  it('fecha HTTP', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });
  it('malformado → null', () => expect(parseRetryAfter('pronto', 0)).toBeNull());
  it('ausente → null', () => expect(parseRetryAfter(undefined, 0)).toBeNull());
});

describe('CircuitBreaker (R-11)', () => {
  const esLimitante = (e: unknown) => e instanceof HttpError;

  it('abre a los 5 fallos limitantes consecutivos y rechaza inmediato', () => {
    const t = 0;
    const cb = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 5; i++) cb.registrarFallo(true);
    expect(cb.state).toBe('OPEN');
    expect(cb.puedePasar()).toBe(false);
  });

  it('OPEN → HALF_OPEN tras cooldown → CLOSED con éxito', () => {
    let t = 0;
    const cb = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 5; i++) cb.registrarFallo(true);
    expect(cb.state).toBe('OPEN');
    t = 120_000; // vence cooldown
    expect(cb.puedePasar()).toBe(true); // pasa 1 sonda
    expect(cb.state).toBe('HALF_OPEN');
    cb.registrarExito();
    expect(cb.state).toBe('CLOSED');
  });

  it('sonda fallida re-abre con cooldown duplicado', () => {
    let t = 0;
    const cb = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 5; i++) cb.registrarFallo(true);
    t = 120_000;
    cb.puedePasar(); // HALF_OPEN
    cb.registrarFallo(true); // sonda falla
    expect(cb.state).toBe('OPEN');
    t = 120_000 + 200_000; // aún dentro del cooldown duplicado (240s)? 320<240k? sí pasó
    // a los 240s exactos vence
    t = 120_000 + 240_000;
    expect(cb.puedePasar()).toBe(true);
  });

  it('exec rechaza con CircuitOpenError cuando está OPEN', async () => {
    const t = 0;
    const cb = new CircuitBreaker(undefined, () => t);
    for (let i = 0; i < 5; i++) cb.registrarFallo(true);
    await expect(cb.exec(async () => 'x', esLimitante)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('4xx≠429 no cuenta como limitante para abrir', () => {
    const cb = new CircuitBreaker();
    for (let i = 0; i < 10; i++) cb.registrarFallo(false);
    expect(cb.state).toBe('CLOSED');
  });
});

describe('RateLimiter (R-16)', () => {
  it('espacia el segundo inicio ≥ minInterval (jitter 0)', async () => {
    let t = 0;
    const sleeps: number[] = [];
    const deps: RetryDeps = {
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms; // el reloj avanza con el sleep simulado
      },
      rng: () => 0.5, // jitter neutro → gap = minInterval
      now: () => t,
    };
    const rl = new RateLimiter(2000, 0.5, deps);
    await rl.schedule(async () => 'a');
    await rl.schedule(async () => 'b');
    expect(sleeps).toContain(2000);
  });
});
