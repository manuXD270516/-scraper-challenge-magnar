/**
 * scraper/run.ts — Orquestación (inyectable, testeable offline): recorre páginas, escribe
 * datos, descarga PDFs, actualiza checkpoint por página y registra fallos en el ledger.
 * Spec: specs/F7_cli_logging.md, F6. No conoce axios ni el sitio: solo colaboradores.
 */
import type { Config } from '../config.js';
import type { Contadores, CriterioBusqueda, Documento } from '../types.js';
import type { Paginator } from './paginator.js';
import type { PdfDownloader } from './pdf.js';
import type { Store } from '../state/store.js';
import type { Logger } from '../logger.js';

export interface RunDeps {
  paginator: Paginator;
  downloader: PdfDownloader;
  store: Store;
  logger: Logger;
  /** Añade una línea JSONL a documentos.jsonl (append seguro). */
  escribirLinea(jsonl: string): Promise<void>;
  now(): number;
  ahoraIso(): string;
}

function contadoresVacios(): Contadores {
  return { paginas: 0, documentos: 0, pdfsOk: 0, pdfsSkip: 0, fallos: 0 };
}

/** Documento mínimo para reintentar una descarga desde el ledger (sin metadatos ricos). */
function docMinimo(id: string, url: string): Documento {
  return {
    id,
    expediente: null,
    organo: null,
    fecha: null,
    fechaTexto: null,
    tipoResolucion: null,
    materia: null,
    sumilla: null,
    partes: null,
    pdfUrl: url,
    camposExtra: {},
  };
}

/** Corrida principal: pagina, extrae, descarga, checkpointea. Reanuda si hay estado. */
export async function ejecutarScrape(
  criterio: CriterioBusqueda,
  config: Config,
  deps: RunDeps,
): Promise<Contadores> {
  const { paginator, downloader, store, logger } = deps;
  const previo = config.resume ? await store.cargarEstado() : null;
  const procesados = new Set<string>(previo?.idsProcesados ?? []);
  const contadores = previo?.contadores ?? contadoresVacios();
  const criterioEfectivo = previo?.criterio ?? criterio;
  const desde = (previo?.ultimaPaginaCompletada ?? 0) + 1;
  if (previo) logger.info(`Reanudando desde la página ${desde} (${procesados.size} docs ya hechos)`);

  const inicio = deps.now();
  let restante = config.maxLimit;

  for await (const pagina of paginator.paginas(criterioEfectivo, {
    maxPages: config.maxPages,
    desde,
  })) {
    contadores.paginas++;
    // Una página cortada por --limit no se marca completada: al reanudar se re-visita y los
    // docs ya hechos se saltan (idsProcesados). Así el límite no pierde el resto de la página.
    let cortadaPorLimite = false;
    for (const doc of pagina.documentos) {
      if (restante !== null && restante <= 0) {
        cortadaPorLimite = true;
        break;
      }
      if (procesados.has(doc.id)) continue;

      await deps.escribirLinea(JSON.stringify(doc));
      contadores.documentos++;

      try {
        const r = await downloader.descargar(doc);
        if (r.estado === 'ok') {
          contadores.pdfsOk++;
          logger.debug(`PDF ok: ${r.ruta}`);
        } else if (r.estado === 'skip') {
          contadores.pdfsSkip++;
        } else {
          contadores.fallos++;
          await store.registrarFallo({
            id: doc.id,
            url: doc.pdfUrl ?? '',
            etapa: 'descarga',
            motivo: r.motivo,
            intentos: 1,
            timestamp: deps.ahoraIso(),
          });
          logger.warn(`PDF fallo (${doc.id}): ${r.motivo}`);
        }
      } catch (err) {
        contadores.fallos++;
        await store.registrarFallo({
          id: doc.id,
          url: doc.pdfUrl ?? '',
          etapa: 'descarga',
          motivo: err instanceof Error ? err.message : String(err),
          intentos: 1,
          timestamp: deps.ahoraIso(),
        });
        logger.error(`Error descargando ${doc.id}: ${String(err)}`);
      }

      procesados.add(doc.id);
      if (restante !== null) restante--;
    }

    // Checkpoint atómico al cerrar cada página (R-12). Si la página quedó cortada por límite,
    // no se avanza el puntero de página completada (se re-visitará al reanudar).
    await store.guardarEstado({
      criterio: criterioEfectivo,
      ultimaPaginaCompletada: cortadaPorLimite ? pagina.numero - 1 : pagina.numero,
      idsProcesados: [...procesados],
      contadores,
      actualizado: deps.ahoraIso(),
    });
    logger.progresoPagina(pagina.numero, pagina.documentos.length, contadores);

    if (restante !== null && restante <= 0) {
      logger.info(`Límite de ${config.maxLimit} documentos alcanzado.`);
      break;
    }
  }

  logger.resumen(contadores, deps.now() - inicio, null);
  return contadores;
}

/** Consume el ledger: reintenta las descargas fallidas y saca del ledger las que resuelven. */
export async function ejecutarRetryFailed(config: Config, deps: RunDeps): Promise<Contadores> {
  const { downloader, store, logger } = deps;
  const fallos = (await store.leerFallos()).filter((f) => f.etapa === 'descarga');
  const contadores = contadoresVacios();
  if (fallos.length === 0) {
    logger.info('El ledger de fallidos está vacío: nada que reintentar.');
    return contadores;
  }
  logger.info(`Reintentando ${fallos.length} descargas del ledger…`);

  let restante = config.maxLimit;
  for (const f of fallos) {
    if (restante !== null && restante <= 0) break;
    contadores.documentos++;
    const r = await downloader.descargar(docMinimo(f.id, f.url));
    if (r.estado === 'ok' || r.estado === 'skip') {
      await store.quitarFallo(f.id, f.etapa);
      contadores.pdfsOk += r.estado === 'ok' ? 1 : 0;
      contadores.pdfsSkip += r.estado === 'skip' ? 1 : 0;
      logger.info(`Recuperado: ${f.id}`);
    } else {
      contadores.fallos++;
      // Acumula intentos sin duplicar la entrada (R-10).
      await store.registrarFallo({ ...f, intentos: 1, timestamp: deps.ahoraIso(), motivo: r.motivo });
      logger.warn(`Sigue fallando (${f.id}): ${r.motivo}`);
    }
    if (restante !== null) restante--;
  }

  logger.resumen(contadores, 0, null);
  return contadores;
}
