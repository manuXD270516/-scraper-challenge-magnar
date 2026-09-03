/**
 * jsf/session.ts — Ciclo de vida JSF: init, parse/renovación de ViewState, detección de
 * ViewExpired (lanza `ViewExpired`; la re-siembra de la secuencia completa la hace
 * JsfPageSource, que conoce init → búsqueda → página). Ancla: doc 01 §D-1. Spec: F1 §7.
 *
 * Nota (R-20): scrapear JSF es reproducir una conversación con estado. El ViewState es un
 * token opaco que el servidor renueva en CADA respuesta; enviarlo viejo (o perder la cookie
 * de nodo) es donde mueren los scrapers ingenuos de JSF en la página 2.
 */
import * as cheerio from 'cheerio';
import type { HttpClient } from '../http/client.js';
import { assertOk } from '../http/client.js';
import type { HttpResponse } from '../types.js';

export class ViewStateNotFound extends Error {
  constructor() {
    super('No se encontró javax.faces.ViewState en la respuesta');
    this.name = 'ViewStateNotFound';
  }
}
export class SessionSeedFailed extends Error {}
/** La vista/sesión JSF expiró. La recuperación (re-sembrar la secuencia completa) es
 * responsabilidad de quien conoce esa secuencia (JsfPageSource), no de submit. */
export class ViewExpired extends Error {
  constructor() {
    super('javax.faces.ViewExpiredException: la vista JSF expiró');
    this.name = 'ViewExpired';
  }
}
export class AccessBlocked extends Error {
  constructor(readonly transactionId?: string) {
    super('Acceso bloqueado por el WAF (403)');
    this.name = 'AccessBlocked';
  }
}

/** Extrae el ViewState de un HTML completo o de un `<partial-response>` AJAX. */
export function parseViewState(html: string): string {
  // Las respuestas AJAX RichFaces son XML con CDATA: hay que parsearlas en modo XML para
  // que el contenido del <update> (dentro de <![CDATA[...]]>) sea legible.
  const esParcial = /<partial-response/i.test(html);
  const $ = cheerio.load(html, { xmlMode: esParcial });
  // Caso AJAX: <update id="javax.faces.ViewState"><![CDATA[...]]></update>
  const upd = $('update[id="javax.faces.ViewState"]').first();
  if (upd.length > 0) {
    const v = upd.text().trim();
    if (v) return v;
  }
  // Caso HTML full: <input name="javax.faces.ViewState" value="...">
  const input = $('input[name="javax.faces.ViewState"]').first();
  const v = input.attr('value');
  if (v && v.trim()) return v.trim();
  throw new ViewStateNotFound();
}

/** ¿La respuesta indica sesión/vista expirada? */
export function esViewExpired(resp: HttpResponse): boolean {
  if (/ViewExpiredException/i.test(resp.data)) return true;
  // Redirect a página de error o de inicio con marca de expiración.
  if (resp.status === 500 && /view.*expired/i.test(resp.data)) return true;
  return false;
}

/** ¿Es la página 403 del WAF Radware? Devuelve el Transaction ID si lo trae. */
export function detectarBloqueo(resp: HttpResponse): string | null {
  if (resp.status !== 403) return null;
  const m = resp.data.match(/Transaction ID:\s*<\/h2>\s*([0-9a-f]+)/i);
  return m?.[1] ?? '';
}

export interface JsfSessionDeps {
  client: HttpClient;
  /** URL del GET inicial que siembra cookies + ViewState (p. ej. inicio.xhtml). */
  seedUrl: string;
}

export class JsfSession {
  private _viewState = '';
  private _seeded = false;

  constructor(private readonly deps: JsfSessionDeps) {}

  get viewState(): string {
    return this._viewState;
  }

  /** GET inicial → cookies + ViewState vigente. */
  async init(): Promise<void> {
    const resp = await this.deps.client.get(this.deps.seedUrl);
    const tx = detectarBloqueo(resp);
    if (tx !== null) throw new AccessBlocked(tx);
    if (resp.status >= 400) throw new SessionSeedFailed(`GET inicial devolvió ${resp.status}`);
    this._viewState = parseViewState(resp.data);
    this._seeded = true;
  }

  /**
   * POST del form añadiendo el ViewState vigente; renueva viewState desde la respuesta.
   * Ante ViewExpired lanza `ViewExpired`: la recuperación (re-sembrar init + búsqueda + página)
   * la hace JsfPageSource, que es quien conoce la secuencia completa. Reintentar aquí solo el
   * último submit iría contra una sesión sin la búsqueda sembrada (shell vacía).
   */
  async submit(
    url: string,
    form: Record<string, string>,
    headers: Record<string, string> = {},
  ): Promise<HttpResponse> {
    if (!this._seeded) await this.init();
    const conViewState = { ...form, 'javax.faces.ViewState': this._viewState };
    const resp = await this.deps.client.postForm(url, conViewState, {
      Referer: this.deps.seedUrl,
      ...headers,
    });
    const tx = detectarBloqueo(resp);
    if (tx !== null) throw new AccessBlocked(tx);
    if (esViewExpired(resp)) throw new ViewExpired();
    assertOk(resp); // 4xx/5xx≠expired → HttpError para la política de retry
    this._viewState = parseViewState(resp.data);
    return resp;
  }

  /** Re-siembra la sesión (nueva cookie + ViewState). */
  async reset(): Promise<void> {
    this._seeded = false;
    await this.init();
  }
}
