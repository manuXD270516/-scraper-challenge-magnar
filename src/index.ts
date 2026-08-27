/**
 * index.ts — Entrada CLI: cablea los colaboradores reales y ejecuta scrape | retry-failed.
 * Spec: specs/F7_cli_logging.md. La lógica orquestadora vive en scraper/run.ts (testeable).
 */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, ConfigError, type Config } from './config.js';
import { Logger } from './logger.js';
import { AxiosHttpClient } from './http/client.js';
import { ResilientHttpClient } from './http/pipeline.js';
import { CircuitBreaker, realDeps } from './http/resilience.js';
import { JsfSession } from './jsf/session.js';
import { JsfPageSource } from './scraper/jsfPageSource.js';
import { Paginator } from './scraper/paginator.js';
import { PdfDownloader, type PdfFetcher } from './scraper/pdf.js';
import { FileStore } from './state/store.js';
import { aCsv } from './scraper/extractor.js';
import { ejecutarScrape, ejecutarRetryFailed, type RunDeps } from './scraper/run.js';
import type { CriterioBusqueda, Documento } from './types.js';

function inicioUrlDe(baseUrl: string): string {
  return baseUrl.replace(/resultado\.xhtml.*$/, 'inicio.xhtml');
}

/** Resuelve un pdfUrl (path o absoluto) contra el origin del portal. */
function absoluto(base: string, pdfUrl: string): string {
  return new URL(pdfUrl, base).toString();
}

async function construirDeps(config: Config, logger: Logger): Promise<RunDeps> {
  const dataDir = join(config.outDir, 'data');
  const pdfsDir = join(config.outDir, 'pdfs');
  await mkdir(dataDir, { recursive: true });
  await mkdir(pdfsDir, { recursive: true });
  const jsonlPath = join(dataDir, 'documentos.jsonl');

  let paginator: Paginator;
  let fetcher: PdfFetcher;

  if (config.dryRun) {
    // Modo demo offline: sirve la fixture poblada y el PDF real; no toca el sitio (D-F0-2).
    logger.info('DRY-RUN: corriendo contra fixtures locales (no se toca el sitio).');
    const htmlFixture = await readFile(
      join('test', 'fixtures', 'resultado-poblada-SINTETICA.html'),
      'utf8',
    );
    const pdfFixture = await readFile(join('test', 'fixtures', 'servlet-descarga-sample.pdf'));
    paginator = new Paginator({
      async pagina(_c, n) {
        return n === 1 ? htmlFixture : null;
      },
    });
    fetcher = async () => ({ status: 200, headers: {}, body: pdfFixture });
  } else {
    const inner = new AxiosHttpClient(config.timeoutMs);
    const breaker = new CircuitBreaker();
    const client = new ResilientHttpClient(inner, breaker, realDeps, {
      minIntervalMs: config.minIntervalMs,
      jitterRatio: config.jitterRatio,
    });
    const session = new JsfSession({ client, seedUrl: inicioUrlDe(config.baseUrl) });
    const source = new JsfPageSource(session, inicioUrlDe(config.baseUrl), config.baseUrl);
    paginator = new Paginator(source);
    fetcher = (url) => client.getBuffer(absoluto(config.baseUrl, url));
  }

  const downloader = new PdfDownloader(pdfsDir, fetcher);
  const store = new FileStore(config.outDir);

  return {
    paginator,
    downloader,
    store,
    logger,
    escribirLinea: (linea) => appendFile(jsonlPath, linea + '\n', 'utf8'),
    now: () => Date.now(),
    ahoraIso: () => new Date().toISOString(),
  };
}

/** Regenera output/data/index.csv a partir de documentos.jsonl (índice completo, R-06). */
async function generarIndiceCsv(config: Config): Promise<number> {
  const jsonlPath = join(config.outDir, 'data', 'documentos.jsonl');
  if (!existsSync(jsonlPath)) return 0;
  const contenido = await readFile(jsonlPath, 'utf8');
  const docs: Documento[] = [];
  const vistos = new Set<string>();
  for (const linea of contenido.split('\n')) {
    if (linea.trim().length === 0) continue;
    let doc: Documento;
    try {
      doc = JSON.parse(linea) as Documento;
    } catch {
      // Línea corrupta (p. ej. append interrumpido por kill -9): se salta, no aborta el índice.
      continue;
    }
    // Deduplica por id: un kill entre append y checkpoint pudo dejar una línea repetida.
    if (doc.id && !vistos.has(doc.id)) {
      vistos.add(doc.id);
      docs.push(doc);
    }
  }
  await writeFile(join(config.outDir, 'data', 'index.csv'), aCsv(docs), 'utf8');
  return docs.length;
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = parseConfig(process.argv.slice(2), process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`Error de uso: ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = new Logger(config.logLevel);
  const deps = await construirDeps(config, logger);

  // Criterio de búsqueda por defecto: universo completo (sin filtros). Ajustable por flags.
  const criterio: CriterioBusqueda = {};

  try {
    if (config.comando === 'retry-failed') {
      await ejecutarRetryFailed(config, deps);
    } else {
      await ejecutarScrape(criterio, config, deps);
    }
    const n = await generarIndiceCsv(config);
    logger.info(`Índice CSV generado con ${n} documentos.`);
  } catch (err) {
    logger.error(`Corrida abortada: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

void main();
