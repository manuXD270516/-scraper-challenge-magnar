/**
 * http/pipeline.ts — Cliente resiliente: compone RateLimiter + CircuitBreaker + retryWithBackoff
 * alrededor de un HttpClient. Centraliza la política de errores para navegación y descargas.
 * Spec: specs/F5_resiliencia_429.md (integración). Ancla: doc 01 §D-2.
 *
 * Orden de composición (de fuera a dentro): rateLimiter → breaker → retry → transporte.
 *  - rateLimiter espacia los inicios (cortesía).
 *  - breaker corta en seco si el sitio nos está limitando (pausa colectiva).
 *  - retry reintenta el request individual con backoff.
 */
import {
  CircuitBreaker,
  CircuitOpenError,
  HttpError,
  RateLimiter,
  RetryExhausted,
  esStatusLimitante,
  retryWithBackoff,
  type RetryDeps,
} from './resilience.js';
import type { HttpClient } from './client.js';
import type { HttpResponse } from '../types.js';

/** ¿El error cuenta como "el sitio me limita" para el circuit breaker? */
export function esLimitante(err: unknown): boolean {
  if (err instanceof CircuitOpenError) return false; // ya está pausado, no re-cuenta
  if (err instanceof HttpError) return esStatusLimitante(err.status);
  if (err instanceof RetryExhausted) return esLimitante(err.ultimoError);
  // Errores de red/timeout (sin status) también son limitantes.
  return true;
}

/** Convierte una respuesta 429/5xx en HttpError para disparar la política de retry. */
function lanzarSiLimitante(resp: { status: number; headers: Record<string, string> }): void {
  if (esStatusLimitante(resp.status)) {
    throw new HttpError(resp.status, resp.headers['retry-after']);
  }
}

export interface OpcionesResiliencia {
  minIntervalMs: number;
  jitterRatio: number;
  /**
   * Hook genérico: si devuelve true para una respuesta de texto, ésta se entrega tal cual al
   * llamador aunque su status sea 5xx (no se reintenta ni cuenta para el breaker). Lo configura
   * la capa que sabe interpretar el cuerpo (p. ej. JSF sirve ViewExpiredException como 500 y la
   * sesión debe verla para re-sembrar, no reintentarla como error de red). Esta capa NO conoce
   * JSF: solo ofrece el punto de extensión.
   */
  dejarPasar?: (resp: HttpResponse) => boolean;
}

export class ResilientHttpClient implements HttpClient {
  private readonly rate: RateLimiter;
  private readonly dejarPasar: (resp: HttpResponse) => boolean;

  constructor(
    private readonly inner: HttpClient,
    private readonly breaker: CircuitBreaker,
    private readonly deps: RetryDeps,
    opts: OpcionesResiliencia,
  ) {
    this.rate = new RateLimiter(opts.minIntervalMs, opts.jitterRatio, deps);
    this.dejarPasar = opts.dejarPasar ?? (() => false);
  }

  private async ejecutar<T>(op: () => Promise<T>): Promise<T> {
    return this.rate.schedule(async () => {
      // Si el breaker está OPEN, PAUSA colectiva hasta el fin del cooldown (R-11) en vez de
      // fast-fallar cada request al ledger. Al despertar, exec deja pasar la sonda (HALF_OPEN).
      const espera = this.breaker.msHastaProximoIntento();
      if (espera > 0) await this.deps.sleep(espera);
      return this.breaker.exec(() => retryWithBackoff(op, this.deps), esLimitante);
    });
  }

  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    return this.ejecutar(async () => {
      const resp = await this.inner.get(url, headers);
      if (!this.dejarPasar(resp)) lanzarSiLimitante(resp);
      return resp;
    });
  }

  async postForm(
    url: string,
    form: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<HttpResponse> {
    return this.ejecutar(async () => {
      const resp = await this.inner.postForm(url, form, headers);
      if (!this.dejarPasar(resp)) lanzarSiLimitante(resp);
      return resp;
    });
  }

  async getBuffer(
    url: string,
    headers?: Record<string, string>,
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return this.ejecutar(async () => {
      const resp = await this.inner.getBuffer(url, headers);
      lanzarSiLimitante(resp);
      return resp;
    });
  }
}
