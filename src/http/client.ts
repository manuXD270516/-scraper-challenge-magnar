/**
 * http/client.ts — Cliente HTTP: axios + cookie jar (tough-cookie) + headers browser-like
 * + timeouts. No lanza por status (validateStatus siempre true): el pipeline clasifica.
 * Spec: specs/F1_sesion_jsf.md. Ancla: doc 01 §D-1.
 */
import axios, { type AxiosInstance } from 'axios';
import { CookieJar } from 'tough-cookie';
import { HttpError } from './resilience.js';
import type { HttpResponse } from '../types.js';

/** Contrato mínimo que consumen jsf/ y scraper/ (permite un fake en tests, sin red). */
export interface HttpClient {
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse>;
  postForm(
    url: string,
    form: Record<string, string>,
    headers?: Record<string, string>,
  ): Promise<HttpResponse>;
  /** Descarga binaria (PDF). */
  getBuffer(url: string, headers?: Record<string, string>): Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
  }>;
}

/**
 * Headers browser-like. Set mínimo verificado como necesario en portales tras WAF
 * (ABIERTO-4). El 403 actual es por IP/reputación, no por estos headers (ver bitácora).
 */
export const HEADERS_BROWSER: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-PE,es;q=0.9,en;q=0.8',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'same-origin',
};

function normalizarHeaders(h: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (h && typeof h === 'object') {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
      if (v === undefined || v === null) continue;
      out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
  }
  return out;
}

export class AxiosHttpClient implements HttpClient {
  private readonly ax: AxiosInstance;

  constructor(
    private readonly timeoutMs: number,
    readonly jar: CookieJar = new CookieJar(),
  ) {
    this.ax = axios.create({
      timeout: timeoutMs,
      maxRedirects: 5,
      // No lanzar por status: el pipeline decide qué reintentar (429) y qué al ledger.
      validateStatus: () => true,
      headers: { ...HEADERS_BROWSER },
      responseType: 'text',
      transitional: { clarifyTimeoutError: true },
    });
    this.instalarCookieJar(jar);
  }

  /**
   * Cookie jar con tough-cookie vía interceptores (D-1). Enviamos la cookie vigente en cada
   * request y guardamos las Set-Cookie de cada respuesta. Preserva el sufijo de nodo del
   * JSESSIONID (sticky session) porque va dentro del valor de la cookie, no como atributo.
   */
  private instalarCookieJar(jar: CookieJar): void {
    this.ax.interceptors.request.use(async (config) => {
      const url = config.url ?? '';
      const cookie = await jar.getCookieString(url);
      if (cookie) config.headers.set('Cookie', cookie);
      return config;
    });
    this.ax.interceptors.response.use(async (resp) => {
      const url = resp.config.url ?? '';
      const setCookies = resp.headers['set-cookie'];
      if (Array.isArray(setCookies)) {
        for (const c of setCookies) {
          await jar.setCookie(c, url, { ignoreError: true });
        }
      }
      return resp;
    });
  }

  async get(url: string, headers: Record<string, string> = {}): Promise<HttpResponse> {
    const r = await this.ax.get(url, { headers });
    return { status: r.status, headers: normalizarHeaders(r.headers), data: String(r.data ?? '') };
  }

  async postForm(
    url: string,
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<HttpResponse> {
    const body = new URLSearchParams(form).toString();
    const r = await this.ax.post(url, body, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: new URL(url).origin,
      },
    });
    return { status: r.status, headers: normalizarHeaders(r.headers), data: String(r.data ?? '') };
  }

  async getBuffer(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
    const r = await this.ax.get(url, { headers, responseType: 'arraybuffer' });
    return {
      status: r.status,
      headers: normalizarHeaders(r.headers),
      body: Buffer.from(r.data as ArrayBuffer),
    };
  }
}

/** Lanza HttpError (con Retry-After) si status ≥ 400, para que la política de retry actúe. */
export function assertOk(resp: { status: number; headers: Record<string, string> }): void {
  if (resp.status >= 400) {
    throw new HttpError(resp.status, resp.headers['retry-after']);
  }
}
