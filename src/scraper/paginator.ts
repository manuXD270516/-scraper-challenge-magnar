/**
 * scraper/paginator.ts — Itera todas las páginas de resultados con doble condición de fin.
 * Spec: specs/F2_paginacion.md. Usa http + jsf (nunca al revés).
 *
 * La mecánica JSF concreta vive tras `PageSource` (ABIERTO-1): el paginator solo conoce
 * "dame la página N como HTML". Así la lógica de fin —lo confirmable y crítico (R-03)— se
 * prueba sin red, y la mecánica se ajusta aparte cuando llegue la fixture real.
 */
import type { CriterioBusqueda, ResultadoPagina } from '../types.js';
import { extraer, extraerTotal } from './extractor.js';

/** Fuente de páginas: devuelve el HTML de la página N (1-based), o null si no hay más. */
export interface PageSource {
  pagina(criterio: CriterioBusqueda, n: number): Promise<string | null>;
}

export interface OpcionesPaginacion {
  maxPages: number | null;
  /** Página desde la que reanudar (1-based). Default 1. */
  desde?: number;
}

function hashIds(ids: string[]): string {
  return ids.slice().sort().join('|');
}

export class Paginator {
  constructor(private readonly source: PageSource) {}

  /**
   * Emite páginas perezosamente. Termina por doble condición (R-03):
   *  (a) se alcanzó el total declarado por el sitio, o
   *  (b) página vacía o repetida (mismo conjunto de ids que la anterior).
   * `maxPages` acota; nunca hay loop infinito (repetición/vacío siempre terminan).
   */
  async *paginas(
    criterio: CriterioBusqueda,
    opts: OpcionesPaginacion,
  ): AsyncIterable<ResultadoPagina> {
    const desde = Math.max(1, opts.desde ?? 1);
    let total: number | null = null;
    let acumulado = 0;
    let hashPrevio: string | null = null;

    for (let n = desde; ; n++) {
      if (opts.maxPages !== null && n - desde >= opts.maxPages) return;

      const html = await this.source.pagina(criterio, n);
      if (html === null) return; // la fuente indica que no hay más

      if (total === null) total = extraerTotal(html);
      const documentos = extraer(html);

      // Fin (b): página vacía tras haber empezado.
      if (documentos.length === 0) {
        if (n > desde) return;
        // Primera página vacía: no hay resultados; emite una página vacía y termina.
        yield { numero: n, documentos, haySiguiente: false };
        return;
      }

      const hash = hashIds(documentos.map((d) => d.id));
      // Fin (b): página repetida (el sitio ignoró el avance) → evita loop infinito.
      if (hashPrevio !== null && hash === hashPrevio) return;
      hashPrevio = hash;
      acumulado += documentos.length;

      // Fin (a): total alcanzado.
      const haySiguiente = total === null ? true : acumulado < total;
      yield { numero: n, documentos, haySiguiente };
      if (!haySiguiente) return;
    }
  }
}
