/**
 * logger.ts — Logging con niveles + progreso + resumen final. Spec: specs/F7_cli_logging.md.
 */
import type { LogLevel } from './config.js';
import type { Contadores } from './types.js';

const ORDEN: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type Sink = (linea: string) => void;

export class Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly sink: Sink = console.log,
  ) {}

  private emitir(nivel: LogLevel, msg: string): void {
    if (ORDEN[nivel] >= ORDEN[this.level]) {
      this.sink(`[${nivel.toUpperCase()}] ${msg}`);
    }
  }

  debug(msg: string): void {
    this.emitir('debug', msg);
  }
  info(msg: string): void {
    this.emitir('info', msg);
  }
  warn(msg: string): void {
    this.emitir('warn', msg);
  }
  error(msg: string): void {
    this.emitir('error', msg);
  }

  /** Progreso de una página. */
  progresoPagina(n: number, docsEnPagina: number, c: Contadores): void {
    this.info(
      `página ${n} · ${docsEnPagina} docs · acumulado: ${c.documentos} docs, ` +
        `${c.pdfsOk} PDF ok, ${c.pdfsSkip} skip, ${c.fallos} fallos`,
    );
  }

  /** Resumen final, en forma pegable al README (R-24). */
  resumen(c: Contadores, duracionMs: number, totalEstimado: number | null): void {
    const seg = (duracionMs / 1000).toFixed(1);
    this.info('──────── Resumen de la corrida ────────');
    this.info(`páginas: ${c.paginas}`);
    this.info(`documentos: ${c.documentos}`);
    this.info(`PDFs ok: ${c.pdfsOk} · skip: ${c.pdfsSkip} · fallos: ${c.fallos}`);
    this.info(`duración: ${seg}s`);
    if (totalEstimado !== null && c.documentos > 0) {
      const porDoc = duracionMs / c.documentos;
      const horas = ((porDoc * totalEstimado) / 3_600_000).toFixed(1);
      this.info(`estimación corrida completa (${totalEstimado} docs): ~${horas} h al ritmo actual`);
    }
  }
}
