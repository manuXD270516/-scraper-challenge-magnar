import { describe, it, expect } from 'vitest';
import { Paginator, PaginaNoParseable, esPaginaResultados, type PageSource } from '../src/scraper/paginator.js';
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

  it('se detiene ante un CICLO de período 2 (p1,p2,p1,p2…) sin loop infinito', async () => {
    // Sin total y sin maxPages: el único cortafuegos es "sin ids nuevos".
    const src = fakeSource([
      pagina([uuid(1), uuid(2)]),
      pagina([uuid(3), uuid(4)]),
      pagina([uuid(1), uuid(2)]), // vuelve al inicio del ciclo
      pagina([uuid(3), uuid(4)]),
    ]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(2); // p3 no aporta ids nuevos → fin
  });

  it('página no-parseable (error/login) lanza PaginaNoParseable, NO se toma como fin', async () => {
    const src = fakeSource([pagina([uuid(1)]), '<html><body>403 Forbidden</body></html>']);
    const it = new Paginator(src).paginas({}, { maxPages: null });
    await expect(juntar(it)).rejects.toBeInstanceOf(PaginaNoParseable);
  });

  it('total con duplicados: no marca falso incompleto ni pide página de más', async () => {
    // El sitio declara 4 (contó un doc dos veces); hay 3 únicos. El conteo BRUTO (2+2=4)
    // alcanza el total en la 2ª página → para limpio, sin pedir una 3ª ni lanzar PaginaNoParseable.
    const src = fakeSource([
      pagina([uuid(1), uuid(2)], 4),
      pagina([uuid(2), uuid(3)]), // uuid(2) es duplicado
      pagina([]), // no debería pedirse; si se pidiera, sería un falso PaginaNoParseable
    ]);
    const pags = await juntar(new Paginator(src).paginas({}, { maxPages: null }));
    expect(pags).toHaveLength(2);
    expect(pags[1]?.haySiguiente).toBe(false);
  });

  it('shell JSF vacía (con ViewState) ANTES del total → PaginaNoParseable, no fin (H1)', async () => {
    // El servidor degrada a la shell vacía al perder la sesión: TRAE ViewState pero 0 docs.
    // Como el total (5) no se alcanzó, es truncamiento, no fin de resultados.
    const shell = '<form id="formBuscador"><input name="javax.faces.ViewState" value="x"/></form>';
    const src = fakeSource([pagina([uuid(1), uuid(2)], 5), shell]);
    await expect(juntar(new Paginator(src).paginas({}, { maxPages: null }))).rejects.toBeInstanceOf(
      PaginaNoParseable,
    );
  });

  it('esPaginaResultados distingue resultados de página de error', () => {
    expect(esPaginaResultados('<form id="formBuscador"></form>')).toBe(true);
    expect(esPaginaResultados('<input name="javax.faces.ViewState"/>')).toBe(true);
    expect(esPaginaResultados('<html>403 Forbidden</html>')).toBe(false);
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
