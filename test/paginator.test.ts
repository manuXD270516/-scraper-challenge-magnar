import { describe, it, expect } from 'vitest';
import { Paginator, type PageSource } from '../src/scraper/paginator.js';
import type { CriterioBusqueda, ResultadoPagina } from '../src/types.js';

/** Genera una página HTML con `ids` documentos y un total opcional. */
function pagina(ids: string[], total?: number): string {
  const enlaces = ids
    .map(
      (id) =>
        `<div class="resolucion"><table><tr><td>Expediente:</td><td>${id}</td></tr></table>` +
        `<a href="/jurisprudenciaweb/ServletDescarga?uuid=${id}">PDF</a></div>`,
    )
    .join('');
  const contador =
    total !== undefined
      ? `<span id="formBuscador:optResultado">Se encontraron ${total} resultados</span>`
      : '';
  return `<form id="formBuscador">${contador}${enlaces}</form>`;
}

/** PageSource fake a partir de una lista de HTMLs por página (1-based). */
function fakeSource(paginasHtml: (string | null)[]): PageSource {
  return {
    async pagina(_c: CriterioBusqueda, n: number): Promise<string | null> {
      return paginasHtml[n - 1] ?? null;
    },
  };
}

async function juntar(it: AsyncIterable<ResultadoPagina>): Promise<ResultadoPagina[]> {
  const out: ResultadoPagina[] = [];
  for await (const p of it) out.push(p);
  return out;
}

const uuid = (n: number): string => `${n.toString().padStart(8, '0')}-0000-0000-0000-000000000000`;

describe('Paginator — fin por total (R-01/R-03)', () => {
  it('itera hasta cubrir el total y se detiene', async () => {
    const src = fakeSource([
      pagina([uuid(1), uuid(2)], 5),
      pagina([uuid(3), uuid(4)]),
      pagina([uuid(5)]),
      pagina([uuid(6)]), // no debería pedirse
    ]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(3);
    expect(pags.flatMap((p) => p.documentos.map((d) => d.id))).toHaveLength(5);
    expect(pags[2]?.haySiguiente).toBe(false);
  });
});

describe('Paginator — fin por página vacía o repetida (R-03, sin loop infinito)', () => {
  it('se detiene ante una página vacía', async () => {
    const src = fakeSource([pagina([uuid(1)]), pagina([]), pagina([uuid(3)])]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(1);
  });

  it('se detiene ante una página repetida (el sitio ignoró el avance)', async () => {
    const src = fakeSource([pagina([uuid(1), uuid(2)]), pagina([uuid(1), uuid(2)])]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(1); // la repetida no se emite
  });

  it('primera página sin resultados → una página vacía y termina', async () => {
    const src = fakeSource([pagina([])]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(1);
    expect(pags[0]?.documentos).toEqual([]);
    expect(pags[0]?.haySiguiente).toBe(false);
  });
});

describe('Paginator — acotación y reanudación', () => {
  it('--pages k acota', async () => {
    const src = fakeSource([
      pagina([uuid(1)]),
      pagina([uuid(2)]),
      pagina([uuid(3)]),
      pagina([uuid(4)]),
    ]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: 2 }));
    expect(pags).toHaveLength(2);
  });

  it('desde=3 reanuda en la página 3', async () => {
    const src: PageSource = {
      async pagina(_c, n) {
        return n <= 4 ? pagina([uuid(n)]) : null;
      },
    };
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null, desde: 3 }));
    expect(pags[0]?.numero).toBe(3);
    expect(pags.map((p) => p.numero)).toEqual([3, 4]);
  });

  it('sin loop infinito aunque la fuente entregue siempre contenido nuevo pero maxPages corta', async () => {
    const src: PageSource = { async pagina(_c, n) { return pagina([uuid(n)]); } };
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: 10 }));
    expect(pags).toHaveLength(10);
  });
});
