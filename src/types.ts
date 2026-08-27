/**
 * types.ts — Tipos del dominio (contrato SSD). Única fuente de los tipos del dominio.
 * Ancla: doc 01 §1 y §D-4. Specs: F1, F3, F5, F6.
 */

// ── Dominio: documento de jurisprudencia ─────────────────────────────────────
export interface Documento {
  /** uuid del ServletDescarga: clave de dedupe e idempotencia. */
  id: string;
  expediente: string | null;
  organo: string | null;
  /** Fecha ISO (yyyy-mm-dd) si es parseable; si no, null y el crudo va en fechaTexto. */
  fecha: string | null;
  fechaTexto: string | null;
  tipoResolucion: string | null;
  materia: string | null;
  sumilla: string | null;
  partes: string | null;
  /** /jurisprudenciaweb/ServletDescarga?uuid=<id> */
  pdfUrl: string | null;
  /** Todo campo hallado y no mapeado nominalmente: nunca se pierde un dato visible. */
  camposExtra: Record<string, string>;
}

export interface ResultadoPagina {
  numero: number;
  documentos: Documento[];
  haySiguiente: boolean;
}

/** Criterio de búsqueda que siembra la sesión (F2). */
export interface CriterioBusqueda {
  /** Texto libre de la búsqueda general (opcional). */
  texto?: string;
  /** Año de la resolución (partición del universo). */
  anio?: number;
  /** Nivel: 1 Corte Suprema, 2 Corte Superior. */
  nivel?: 1 | 2;
  /** Id de especialidad del catálogo del portal. */
  especialidad?: number;
}

// ── Estado y ledger (F6) ─────────────────────────────────────────────────────
export interface EstadoScraper {
  criterio: CriterioBusqueda;
  ultimaPaginaCompletada: number;
  idsProcesados: string[];
  contadores: Contadores;
  actualizado: string;
}

export interface Contadores {
  paginas: number;
  documentos: number;
  pdfsOk: number;
  pdfsSkip: number;
  fallos: number;
}

export type EtapaFallo = 'paginacion' | 'extract' | 'descarga';

export interface FalloDescarga {
  id: string;
  url: string;
  etapa: EtapaFallo;
  motivo: string;
  intentos: number;
  timestamp: string;
}

// ── Descarga (F4) ────────────────────────────────────────────────────────────
export type ResultadoDescarga =
  | { estado: 'ok'; ruta: string; bytes: number }
  | { estado: 'skip'; ruta: string }
  | { estado: 'fallo'; motivo: string };

// ── HTTP (F1) ────────────────────────────────────────────────────────────────
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  data: string;
}
