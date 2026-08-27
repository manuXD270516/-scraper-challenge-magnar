import { describe, it, expect } from 'vitest';
import { JsfSession } from '../src/jsf/session.js';
import { JsfPageSource } from '../src/scraper/jsfPageSource.js';
import type { HttpClient } from '../src/http/client.js';
import type { HttpResponse } from '../src/types.js';

const ok = (data: string): HttpResponse => ({ status: 200, headers: {}, data });
const VS = (v: string): string => `<input name="javax.faces.ViewState" value="${v}"/>`;

/** Cliente fake con colas separadas de GET (init) y POST (submit). */
class FakeClient implements HttpClient {
  posts = 0;
  gets = 0;
  constructor(
    private getQueue: HttpResponse[],
    private postQueue: HttpResponse[],
  ) {}
  async get(): Promise<HttpResponse> {
    this.gets++;
    return this.getQueue.shift() ?? ok(VS('x'));
  }
  async postForm(): Promise<HttpResponse> {
    this.posts++;
    return this.postQueue.shift() ?? ok('vacío');
  }
  async getBuffer(): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  }
}

describe('JsfPageSource — recuperación de ViewExpired (R-13)', () => {
  it('ante ViewExpired re-ejecuta init + búsqueda + página (secuencia completa)', async () => {
    const client = new FakeClient(
      [ok(VS('seed1')), ok(VS('seed2'))], // dos GET inicio (siembra original + re-siembra)
      [ok('...ViewExpiredException...'), ok(VS('página-ok') + 'RESULTADOS')], // 1º falla, 2º ok
    );
    const session = new JsfSession({ client, seedUrl: 'inicio' });
    const source = new JsfPageSource(session, 'inicio', 'resultado');

    const html = await source.pagina({}, 1);
    expect(html).toContain('RESULTADOS');
    expect(client.gets).toBe(2); // re-sembró (dos inits)
    expect(client.posts).toBe(2); // re-ejecutó la búsqueda
  });

  it('ViewExpired persistente (>2) propaga el error', async () => {
    const client = new FakeClient(
      [ok(VS('s1')), ok(VS('s2')), ok(VS('s3'))],
      [ok('ViewExpiredException'), ok('ViewExpiredException'), ok('ViewExpiredException')],
    );
    const session = new JsfSession({ client, seedUrl: 'inicio' });
    const source = new JsfPageSource(session, 'inicio', 'resultado');
    await expect(source.pagina({}, 1)).rejects.toThrow(/ViewExpired/);
  });
});
