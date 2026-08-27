/**
 * state/store.ts — Persistencia: state.json (checkpoint atómico) + failed.json (ledger).
 * Ninguna interrupción pierde ni duplica trabajo. Spec: specs/F6_estado_reanudacion.md.
 * Ancla: doc 01 §D-3.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EstadoScraper, FalloDescarga } from '../types.js';

export interface Store {
  cargarEstado(): Promise<EstadoScraper | null>;
  guardarEstado(e: EstadoScraper): Promise<void>;
  registrarFallo(f: FalloDescarga): Promise<void>;
  leerFallos(): Promise<FalloDescarga[]>;
  quitarFallo(id: string, etapa: FalloDescarga['etapa']): Promise<void>;
}

/**
 * Escritura atómica: se escribe a `<path>.tmp` y se renombra. Una interrupción entre medias
 * nunca deja el archivo final corrupto: queda el viejo o el nuevo, jamás uno a medias.
 */
async function escribirAtomico(path: string, contenido: string): Promise<void> {
  const tmp = `${path}.tmp`;
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(tmp, contenido, 'utf8');
  await rename(tmp, path);
}

/** Lee y parsea JSON; si está corrupto, respalda a `.corrupt` y devuelve `fallback`. */
async function leerJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  const raw = await readFile(path, 'utf8');
  try {
    return JSON.parse(raw) as T;
  } catch {
    await rename(path, `${path}.corrupt`).catch(() => undefined);
    return fallback;
  }
}

export class FileStore implements Store {
  private readonly statePath: string;
  private readonly failedPath: string;

  constructor(dir: string) {
    this.statePath = join(dir, 'state.json');
    this.failedPath = join(dir, 'failed.json');
  }

  async cargarEstado(): Promise<EstadoScraper | null> {
    return leerJson<EstadoScraper | null>(this.statePath, null);
  }

  async guardarEstado(e: EstadoScraper): Promise<void> {
    await escribirAtomico(this.statePath, JSON.stringify(e, null, 2));
  }

  async leerFallos(): Promise<FalloDescarga[]> {
    return leerJson<FalloDescarga[]>(this.failedPath, []);
  }

  /** Registra un fallo; no duplica por (id, etapa): actualiza intentos/timestamp (R-10). */
  async registrarFallo(f: FalloDescarga): Promise<void> {
    const fallos = await this.leerFallos();
    const i = fallos.findIndex((x) => x.id === f.id && x.etapa === f.etapa);
    if (i >= 0) {
      const previo = fallos[i]!;
      fallos[i] = { ...f, intentos: previo.intentos + f.intentos };
    } else {
      fallos.push(f);
    }
    await escribirAtomico(this.failedPath, JSON.stringify(fallos, null, 2));
  }

  /** Quita una entrada del ledger (p. ej. cuando `retry-failed` la resuelve). */
  async quitarFallo(id: string, etapa: FalloDescarga['etapa']): Promise<void> {
    const fallos = await this.leerFallos();
    const filtrados = fallos.filter((x) => !(x.id === id && x.etapa === etapa));
    if (filtrados.length !== fallos.length) {
      await escribirAtomico(this.failedPath, JSON.stringify(filtrados, null, 2));
    }
  }
}

/** Estado inicial vacío para una corrida nueva. */
export function estadoInicial(criterio: EstadoScraper['criterio']): EstadoScraper {
  return {
    criterio,
    ultimaPaginaCompletada: 0,
    idsProcesados: [],
    contadores: { paginas: 0, documentos: 0, pdfsOk: 0, pdfsSkip: 0, fallos: 0 },
    actualizado: new Date(0).toISOString(),
  };
}
