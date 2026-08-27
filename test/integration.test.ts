import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Paginator, type PageSource } from '../src/scraper/paginator.js';
import { PdfDownloader, type PdfFetcher } from '../src/scraper/pdf.js';
import { FileStore } from '../src/state/store.js';
import { Logger } from '../src/logger.js';
import { ejecutarScrape, ejecutarRetryFailed, type RunDeps } from '../src/scraper/run.js';
import { retryWithBackoff, HttpError, type RetryDeps } from '../src/http/resilience.js';
import type { Config } from '../src/config.js';

const PDF = Buffer.from('%PDF-1.4\n...contenido...\n%%EOF');

/** uuid válido y determinista a partir de un número (el extractor exige 8+ hex). */
const uid = (n: number): string => `${n.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`;

function pagina(ids: string[], total?: number): string {
  const enlaces = ids
    .map(
      (id) =>
        `<div class="resolucion"><table>` +
        `<tr><td>Expediente:</td><td>EXP-${id.slice(0, 8)}</td></tr>` +
        `<tr><td>Fecha:</td><td>10/08/2024</td></tr></table>` +
        `<a href="/jurisprudenciaweb/ServletDescarga?uuid=${id}">PDF</a></div>`,
    )
    .join('');
  const c =
    total !== undefined ? `<span id="formBuscador:optResultado">${total} resultados</span>` : '';
  return `<form id="formBuscador">${c}${enlaces}</form>`;
}

const cfg = (over: Partial<Config> = {}): Config => ({
  comando: 'scrape',
  baseUrl: 'https://x/resultado.xhtml',
  outDir: 'unused',
  timeoutMs: 30000,
  minIntervalMs: 0,
  jitterRatio: 0,
  pdfConcurrency: 1,
  maxLimit: null,
  maxPages: null,
  resume: true,
  logLevel: 'error',
  dryRun: false,
  ...over,
});

const retryDeps: RetryDeps = { sleep: async () => {}, rng: () => 0, now: () => 0 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'int-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function deps(source: PageSource, fetcher: PdfFetcher): RunDeps {
  const jsonl = join(dir, 'documentos.jsonl');
  return {
    paginator: new Paginator(source),
    downloader: new PdfDownloader(dir, fetcher),
    store: new FileStore(dir),
    logger: new Logger('error'),
    escribirLinea: async (l) => appendFileSync(jsonl, l + '\n'),
    now: () => 0,
    ahoraIso: () => '2026-01-01T00:00:00Z',
  };
}

const fuente = (fn: (n: number) => string | null): PageSource => ({
  async pagina(_c, n) {
    return fn(n);
  },
});

describe('integración end-to-end (offline con fakes)', () => {
  it('pagina, extrae, descarga PDFs y checkpointea', async () => {
    const d = deps(
      fuente((n) => (n === 1 ? pagina([uid(1), uid(2)], 2) : null)),
      async () => ({ status: 200, headers: {}, body: PDF }),
    );
    const c = await ejecutarScrape({}, cfg(), d);
    expect(c.documentos).toBe(2);
    expect(c.pdfsOk).toBe(2);
    expect(c.fallos).toBe(0);
    expect(readFileSync(join(dir, 'documentos.jsonl'), 'utf8').trim().split('\n')).toHaveLength(2);
    const estado = await d.store.cargarEstado();
    expect(estado?.idsProcesados).toEqual([uid(1), uid(2)]);
  });

  it('un PDF con 429 persistente va al ledger y el lote continúa (R-09/R-10)', async () => {
    const d = deps(
      fuente((n) => (n === 1 ? pagina([uid(10), uid(11), uid(12)]) : null)),
      (url) =>
        retryWithBackoff(async () => {
          if (url.includes(uid(11))) throw new HttpError(429);
          return { status: 200, headers: {}, body: PDF };
        }, retryDeps),
    );
    const c = await ejecutarScrape({}, cfg(), d);
    expect(c.documentos).toBe(3);
    expect(c.pdfsOk).toBe(2);
    expect(c.fallos).toBe(1);
    const fallos = await d.store.leerFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0]?.id).toBe(uid(11));
  });

  it('reanudación: no reprocesa documentos ya hechos (R-12)', async () => {
    const src = fuente((n) => (n <= 2 ? pagina([uid(100 + n)]) : null));
    let descargas = 0;
    const fetcher: PdfFetcher = async () => {
      descargas++;
      return { status: 200, headers: {}, body: PDF };
    };
    await ejecutarScrape({}, cfg(), deps(src, fetcher));
    expect(descargas).toBe(2);

    await ejecutarScrape({}, cfg(), deps(src, fetcher));
    // Evidencia R-12: al reanudar no se re-descargó ningún PDF ya hecho.
    expect(descargas).toBe(2);
  });

  it('interrupción a mitad de página → reanudar completa el resto sin duplicar (R-12)', async () => {
    // Página única de 3 docs. Primera corrida se corta en 1 (simula kill tras el 1.º).
    const src = fuente((n) => (n === 1 ? pagina([uid(1), uid(2), uid(3)]) : null));
    const descargados: string[] = [];
    const fetcher: PdfFetcher = async (url) => {
      descargados.push(url);
      return { status: 200, headers: {}, body: PDF };
    };
    await ejecutarScrape({}, cfg({ maxLimit: 1 }), deps(src, fetcher));
    expect(descargados).toHaveLength(1); // solo el 1.º

    // Reanuda sin límite: procesa 2.º y 3.º, no re-descarga el 1.º (idsProcesados + skip).
    await ejecutarScrape({}, cfg(), deps(src, fetcher));
    expect(descargados).toHaveLength(3); // 1 + 2, ninguno repetido
    expect(new Set(descargados).size).toBe(3);
  });

  it('--limit corta el número de documentos', async () => {
    const d = deps(
      fuente((n) => (n === 1 ? pagina([uid(1), uid(2), uid(3), uid(4)]) : null)),
      async () => ({ status: 200, headers: {}, body: PDF }),
    );
    const c = await ejecutarScrape({}, cfg({ maxLimit: 2 }), d);
    expect(c.documentos).toBe(2);
  });

  it('retry-failed recupera del ledger y limpia la entrada (R-10)', async () => {
    const store = new FileStore(dir);
    await store.registrarFallo({
      id: uid(99),
      url: `/jurisprudenciaweb/ServletDescarga?uuid=${uid(99)}`,
      etapa: 'descarga',
      motivo: '429-exhausted',
      intentos: 5,
      timestamp: '2026-01-01T00:00:00Z',
    });
    const d = deps(
      fuente(() => null),
      async () => ({ status: 200, headers: {}, body: PDF }),
    );
    const c = await ejecutarRetryFailed(cfg({ comando: 'retry-failed' }), d);
    expect(c.pdfsOk).toBe(1);
    expect(await store.leerFallos()).toHaveLength(0);
    expect(existsSync(join(dir, `documento_${uid(99)}.pdf`))).toBe(true);
  });
});
