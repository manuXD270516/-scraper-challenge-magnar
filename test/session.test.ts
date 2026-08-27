import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseViewState,
  esViewExpired,
  detectarBloqueo,
  JsfSession,
  ViewStateNotFound,
  AccessBlocked,
  SessionResetExhausted,
} from '../src/jsf/session.js';
import type { HttpClient } from '../src/http/client.js';
import type { HttpResponse } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');

/** HttpClient fake: responde de una cola programada; registra los ViewState enviados. */
class FakeClient implements HttpClient {
  gets: string[] = [];
  postedViewStates: string[] = [];
  constructor(
    private getQueue: HttpResponse[],
    private postQueue: HttpResponse[] = [],
  ) {}
  async get(url: string): Promise<HttpResponse> {
    this.gets.push(url);
    return this.getQueue.shift() ?? { status: 500, headers: {}, data: '' };
  }
  async postForm(_url: string, form: Record<string, string>): Promise<HttpResponse> {
    this.postedViewStates.push(form['javax.faces.ViewState'] ?? '');
    return this.postQueue.shift() ?? { status: 500, headers: {}, data: '' };
  }
  async getBuffer(): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    return { status: 200, headers: {}, body: Buffer.alloc(0) };
  }
}

const ok = (data: string): HttpResponse => ({ status: 200, headers: {}, data });

describe('parseViewState (R-13)', () => {
  it('extrae de inicio.html', () => {
    expect(parseViewState(fx('inicio.html'))).toBe('670004145947233129:-8283604206758007905');
  });
  it('extrae de resultado-sin-sesion.html', () => {
    expect(parseViewState(fx('resultado-sin-sesion.html'))).toBe(
      '-3672904194289307332:6709027154229151979',
    );
  });
  it('extrae de partial-response AJAX', () => {
    const xml =
      '<partial-response><changes><update id="javax.faces.ViewState"><![CDATA[9:9]]></update></changes></partial-response>';
    expect(parseViewState(xml)).toBe('9:9');
  });
  it('sin ViewState → ViewStateNotFound', () => {
    expect(() => parseViewState('<html><body>nada</body></html>')).toThrow(ViewStateNotFound);
  });
});

describe('detección de estados', () => {
  it('esViewExpired detecta ViewExpiredException', () => {
    expect(esViewExpired(ok('...ViewExpiredException...'))).toBe(true);
    expect(esViewExpired(ok('ok'))).toBe(false);
  });
  it('detectarBloqueo extrae Transaction ID de la página 403', () => {
    const body = '<h2>403 Forbidden</h2><h2>Transaction ID:</h2> abc123def';
    expect(detectarBloqueo({ status: 403, headers: {}, data: body })).toBe('abc123def');
    expect(detectarBloqueo(ok('x'))).toBeNull();
  });
});

describe('JsfSession (R-13)', () => {
  it('init siembra ViewState desde el GET inicial', async () => {
    const c = new FakeClient([ok(fx('inicio.html'))]);
    const s = new JsfSession({ client: c, seedUrl: 'seed' });
    await s.init();
    expect(s.viewState).toBe('670004145947233129:-8283604206758007905');
  });

  it('submit envía el ViewState vigente y lo renueva desde la respuesta', async () => {
    const c = new FakeClient(
      [ok(fx('inicio.html'))],
      [ok('<input name="javax.faces.ViewState" value="NUEVO:1"/>')],
    );
    const s = new JsfSession({ client: c, seedUrl: 'seed' });
    await s.init();
    await s.submit('res', { a: '1' });
    expect(c.postedViewStates[0]).toBe('670004145947233129:-8283604206758007905'); // el vigente
    expect(s.viewState).toBe('NUEVO:1'); // renovado
  });

  it('ViewExpired → reset + replay con la sesión nueva', async () => {
    const c = new FakeClient(
      [ok(fx('inicio.html')), ok('<input name="javax.faces.ViewState" value="RESEED:2"/>')],
      [ok('ViewExpiredException'), ok('<input name="javax.faces.ViewState" value="OK:3"/>')],
    );
    const s = new JsfSession({ client: c, seedUrl: 'seed' });
    await s.init();
    const r = await s.submit('res', { a: '1' });
    expect(r.data).toContain('OK:3');
    // el segundo POST usó el ViewState re-sembrado
    expect(c.postedViewStates[1]).toBe('RESEED:2');
  });

  it('ViewExpired persistente → SessionResetExhausted', async () => {
    const c = new FakeClient(
      [ok(fx('inicio.html')), ok(fx('inicio.html')), ok(fx('inicio.html'))],
      [ok('ViewExpiredException'), ok('ViewExpiredException'), ok('ViewExpiredException')],
    );
    const s = new JsfSession({ client: c, seedUrl: 'seed' });
    await s.init();
    await expect(s.submit('res', { a: '1' })).rejects.toBeInstanceOf(SessionResetExhausted);
  });

  it('403 del WAF → AccessBlocked con Transaction ID', async () => {
    const body = '<h2>403 Forbidden</h2><h2>Transaction ID:</h2> tx999';
    const c = new FakeClient([{ status: 403, headers: {}, data: body }]);
    const s = new JsfSession({ client: c, seedUrl: 'seed' });
    await expect(s.init()).rejects.toBeInstanceOf(AccessBlocked);
  });
});
