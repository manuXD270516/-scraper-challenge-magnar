/**
 * config.ts — Configuración única del scraper (defaults + env + CLI), tipada.
 * Precedencia: CLI > env > defaults. Ningún número de política vive fuera de aquí.
 * Spec: specs/F7_cli_logging.md (R-17). Ancla: doc 01 §D-2/§D-3.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type Comando = 'scrape' | 'retry-failed';

export interface Config {
  comando: Comando;
  baseUrl: string;
  outDir: string;
  timeoutMs: number;
  minIntervalMs: number;
  jitterRatio: number;
  pdfConcurrency: number;
  maxLimit: number | null;
  maxPages: number | null;
  resume: boolean;
  logLevel: LogLevel;
  /** Corrida offline contra fixtures (no toca el sitio): demo/smoke test. */
  dryRun: boolean;
}

/** Portal peruano: decisión anclada (H-V1); ver docs/insumos y bitácora. */
export const DEFAULT_BASE_URL =
  'https://jurisprudencia.pj.gob.pe/jurisprudenciaweb/faces/page/resultado.xhtml';

export const DEFAULTS: Omit<Config, 'comando'> = {
  baseUrl: DEFAULT_BASE_URL,
  outDir: 'output',
  timeoutMs: 30_000,
  minIntervalMs: 2_000,
  jitterRatio: 0.5,
  pdfConcurrency: 1,
  maxLimit: null,
  maxPages: null,
  resume: true,
  logLevel: 'info',
  dryRun: false,
};

const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

export class ConfigError extends Error {}

interface Env {
  [key: string]: string | undefined;
}

/** Parseo puro: entra argv (sin `node script`) + env, sale Config. Testeable sin proceso. */
export function parseConfig(argv: readonly string[], env: Env = {}): Config {
  const flags = new Map<string, string | boolean>();
  let comando: Comando = 'scrape';

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === 'retry-failed' || tok === '--retry-failed') {
      comando = 'retry-failed';
      continue;
    }
    if (tok === 'scrape') continue;
    if (tok.startsWith('--')) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      // Flags booleanos: no consumen el siguiente argumento.
      const booleanos = new Set(['dry-run', 'no-resume']);
      if (booleanos.has(key) || next === undefined || next.startsWith('--')) {
        flags.set(key, true);
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      throw new ConfigError(`Argumento no reconocido: ${tok}`);
    }
  }

  const num = (v: string | boolean | undefined, name: string): number => {
    const n = Number(v);
    if (typeof v !== 'string' || Number.isNaN(n)) {
      throw new ConfigError(`Flag --${name} espera un número, recibió: ${String(v)}`);
    }
    if (n < 0) throw new ConfigError(`Flag --${name} no admite valores negativos: ${v}`);
    return n;
  };

  const pick = (cli: string, envKey: string): string | boolean | undefined =>
    flags.has(cli) ? flags.get(cli) : env[envKey];

  const logLevelRaw = pick('log-level', 'LOG_LEVEL');
  const logLevel: LogLevel =
    typeof logLevelRaw === 'string' && (LOG_LEVELS as string[]).includes(logLevelRaw)
      ? (logLevelRaw as LogLevel)
      : DEFAULTS.logLevel;

  const limitRaw = pick('limit', 'MAX_LIMIT');
  const pagesRaw = pick('pages', 'MAX_PAGES');
  const intervalRaw = pick('min-interval', 'MIN_INTERVAL_MS');
  const timeoutRaw = pick('timeout', 'TIMEOUT_MS');
  const outRaw = pick('out', 'OUT_DIR');
  const baseRaw = pick('base-url', 'BASE_URL');

  return {
    comando,
    baseUrl: typeof baseRaw === 'string' ? baseRaw : DEFAULTS.baseUrl,
    outDir: typeof outRaw === 'string' ? outRaw : DEFAULTS.outDir,
    timeoutMs: timeoutRaw === undefined ? DEFAULTS.timeoutMs : num(timeoutRaw, 'timeout'),
    minIntervalMs: intervalRaw === undefined ? DEFAULTS.minIntervalMs : num(intervalRaw, 'min-interval'),
    jitterRatio: DEFAULTS.jitterRatio,
    // Concurrencia de descargas fija en 1 (cortesía deliberada, dentro del rango 1–2 de D-2).
    pdfConcurrency: DEFAULTS.pdfConcurrency,
    maxLimit: limitRaw === undefined ? DEFAULTS.maxLimit : num(limitRaw, 'limit'),
    maxPages: pagesRaw === undefined ? DEFAULTS.maxPages : num(pagesRaw, 'pages'),
    resume: flags.has('no-resume') ? false : DEFAULTS.resume,
    logLevel,
    dryRun: flags.has('dry-run'),
  };
}
