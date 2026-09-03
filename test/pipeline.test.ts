import { describe, it, expect } from 'vitest';
import { ResilientHttpClient } from '../src/http/pipeline.js';
import { CircuitBreaker, RetryExhausted, type RetryDeps } from '../src/http/resilience.js';
import { esViewExpired } from '../src/jsf/session.js';
import { formBusqueda } from '../src/jsf/forms.js';
import type { HttpClient } from '../src/http/client.js';
import type { HttpResponse } from '../src/types.js';

const deps: RetryDeps = { sleep: async () => {}, rng: () => 0, now: () => 0 };

/** Cliente fake que siempre responde lo mismo y cuenta llamadas. */
function fakeInner(resp: HttpResponse): HttpClient & { llamadas: number } {
  const c = {
    llamadas: 0,
    async get(): Promise<HttpResponse> {
      c.llamadas++;
      return resp;
    },
    async postForm(): Promise<HttpResponse> {
      c.llamadas++;
      return resp;
    },
    async getBuffer(): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
      return { status: 200, headers: {}, body: Buffer.alloc(0) };
    },
  };
  return c;
}

describe('ResilientHttpClient — hook dejarPasar (ViewExpired servido como 500)', () => {
  const expirada: HttpResponse = {
    status: 500,
    headers: {},
    data: '<html>javax.faces.application.ViewExpiredException: view could not be restored</html>',
  };

  it('sin hook: un 500 se reintenta como error de red y agota (la sesión nunca lo ve)', async () => {
    const inner = fakeInner(expirada);
    const client = new ResilientHttpClient(inner, new CircuitBreaker(), deps, {
      minIntervalMs: 0,
      jitterRatio: 0,
    });
    await expect(client.postForm('u', {})).rejects.toBeInstanceOf(RetryExhausted);
    expect(inner.llamadas).toBe(3); // política red: 3 intentos
  });

  it('con dejarPasar=esViewExpired: el 500 llega intacto y sin reintentos (la sesión re-siembra)', async () => {
    const inner = fakeInner(expirada);
    const client = new ResilientHttpClient(inner, new CircuitBreaker(), deps, {
      minIntervalMs: 0,
      jitterRatio: 0,
      dejarPasar: esViewExpired,
    });
    const resp = await client.postForm('u', {});
    expect(resp.status).toBe(500);
    expect(esViewExpired(resp)).toBe(true);
    expect(inner.llamadas).toBe(1);
  });

  it('el hook no deja pasar un 500 cualquiera', async () => {
    const inner = fakeInner({ status: 500, headers: {}, data: 'Internal Server Error' });
    const client = new ResilientHttpClient(inner, new CircuitBreaker(), deps, {
      minIntervalMs: 0,
      jitterRatio: 0,
      dejarPasar: esViewExpired,
    });
    await expect(client.get('u')).rejects.toBeInstanceOf(RetryExhausted);
  });
});

describe('formBusqueda — tokens JSF', () => {
  it('incluye el clientId del botón (lo que dispara la acción en Mojarra) y los tokens posicionales', () => {
    const f = formBusqueda({ anio: 2024 }, 1);
    expect(f['formBuscador:j_idt69']).toBe('formBuscador:j_idt69');
    expect(f['forward']).toBe('buscar');
    expect(f['formBuscador:j_idt71']).toBe('21');
    expect(f['formBuscador:j_idt74']).toBe('1');
    expect(f['formBuscador:buAnio']).toBe('2024');
  });
});
