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

/** Una página que ni tiene documentos ni parece una página de resultados válida (error/login). */
export class PaginaNoParseable extends Error {
  constructor(readonly numero: number) {
    super(`La página ${numero} no es una página de resultados válida (posible error/login/truncado)`);
    this.name = 'PaginaNoParseable';
  }
}

/**
 * ¿El HTML parece una página de resultados del portal (no una página de error/login)?
 * Marcadores estructurales estables: el form de búsqueda y/o el ViewState de JSF.
 */
export function esPaginaResultados(html: string): boolean {
  return /formBuscador/.test(html) || /javax\.faces\.ViewState/.test(html);
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
    // Ids vistos en TODA la corrida: detecta ciclos de cualquier período, no solo repetición
    // de la página inmediatamente anterior (garantía real de "sin loop infinito").
    const vistos = new Set<string>();

    for (let n = desde; ; n++) {
      if (opts.maxPages !== null && n - desde >= opts.maxPages) return;

      const html = await this.source.pagina(criterio, n);
      if (html === null) return; // la fuente indica que no hay más

      if (total === null) total = extraerTotal(html);
      const documentos = extraer(html);

      if (documentos.length === 0) {
        // Una página vacía puede ser fin legítimo O una pérdida de sesión/error a mitad de
        // paginación (el servidor JSF degrada a la shell vacía, que TAMBIÉN trae ViewState).
        // Árbitro fiable: el total del sitio. Si esperábamos más y no llegó nada, es
        // truncamiento (H1), no fin.
        if (total !== null && acumulado < total) throw new PaginaNoParseable(n);
        // Sin total conocido: si ni siquiera parece página de resultados, es un error claro.
        if (!esPaginaResultados(html)) throw new PaginaNoParseable(n);
        if (n > desde) return; // fin (b): paginación agotada (best-effort sin total)
        yield { numero: n, documentos, haySiguiente: false };
        return;
      }

      // Fin (b): la página no aporta ningún id nuevo (repetida o cíclica) → evita loop infinito.
      const nuevos = documentos.filter((d) => !vistos.has(d.id));
      if (nuevos.length === 0) return;
      for (const d of nuevos) vistos.add(d.id);
      acumulado += nuevos.length;

      // Fin (a): total del sitio alcanzado.
      const haySiguiente = total === null ? true : acumulado < total;
      yield { numero: n, documentos, haySiguiente };
      if (!haySiguiente) return;
    }
  }
}
