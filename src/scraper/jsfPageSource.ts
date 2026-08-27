/**
 * scraper/jsfPageSource.ts — Implementación real de PageSource sobre JsfSession.
 * Traduce "dame la página N" a la conversación JSF: siembra (GET inicio + POST búsqueda) y
 * luego pagina (POST a resultado.xhtml). Mecánica HIPOTÉTICA (ABIERTO-1, deuda D-F0-1),
 * aislada aquí para ajustarla sin tocar el Paginator.
 */
import type { PageSource } from './paginator.js';
import type { JsfSession } from '../jsf/session.js';
import { formBusqueda, formPagina } from '../jsf/forms.js';
import type { CriterioBusqueda } from '../types.js';

export class JsfPageSource implements PageSource {
  private sembrada = false;

  constructor(
    private readonly session: JsfSession,
    private readonly inicioUrl: string,
    private readonly resultadoUrl: string,
  ) {}

  async pagina(criterio: CriterioBusqueda, n: number): Promise<string | null> {
    if (!this.sembrada) {
      await this.session.init(); // GET inicio → cookies + ViewState
      const primera = await this.session.submit(this.inicioUrl, formBusqueda(criterio, 1));
      this.sembrada = true;
      if (n === 1) return primera.data;
    }
    const resp = await this.session.submit(this.resultadoUrl, formPagina(criterio, n));
    return resp.data;
  }
}
