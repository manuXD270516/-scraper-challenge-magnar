/**
 * scraper/pdf.ts — Descarga de PDF: resolución del request, validación (magic bytes),
 * naming descriptivo/seguro/único, escritura atómica y skip idempotente.
 * Spec: specs/F4_descarga_pdf.md. Ancla: doc 01 §D-4. La política de retry (F5) la aporta
 * el fetcher inyectado desde el pipeline: pdf.ts no conoce la red directamente.
 */
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Documento, ResultadoDescarga } from '../types.js';

/** Fetcher binario que el pipeline entrega ya envuelto en retry+breaker+rate limiter. */
export type PdfFetcher = (
  url: string,
) => Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;

/** slug seguro: minúsculas, sin acentos, [a-z0-9-], colapsado y acotado. */
export function slug(s: string | null | undefined, maxLen = 60): string {
  if (!s) return '';
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // quita diacríticos combinantes (NFD)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
}

/** Nombre descriptivo: expediente_organo_fecha.pdf; fallback con uuid si no hay metadatos. */
export function nombreDescriptivo(doc: Documento): string {
  const partes = [slug(doc.expediente), slug(doc.organo), doc.fecha ?? ''].filter(
    (p) => p.length > 0,
  );
  let base = partes.join('_').slice(0, 120);
  if (base.length === 0) base = `documento_${doc.id}`;
  return `${base}.pdf`;
}

/** Resuelve colisiones en una corrida: base.pdf → base-2.pdf → base-3.pdf … */
export function nombreUnico(nombre: string, taken: Set<string>): string {
  if (!taken.has(nombre)) {
    taken.add(nombre);
    return nombre;
  }
  const stem = nombre.replace(/\.pdf$/i, '');
  let i = 2;
  let cand = `${stem}-${i}.pdf`;
  while (taken.has(cand)) {
    i++;
    cand = `${stem}-${i}.pdf`;
  }
  taken.add(cand);
  return cand;
}

/** Magic bytes: el cuerpo empieza con %PDF y tiene tamaño > 0 (R-04). */
export function esPdfValido(body: Buffer): boolean {
  return body.length > 4 && body.subarray(0, 4).toString('latin1') === '%PDF';
}

export class DiskWriteFailed extends Error {}

export class PdfDownloader {
  private readonly taken = new Set<string>();

  constructor(
    private readonly outDir: string,
    private readonly fetchPdf: PdfFetcher,
  ) {}

  /** Descarga a `<outDir>/` con naming descriptivo; skip si ya existe y es válido. */
  async descargar(doc: Documento): Promise<ResultadoDescarga> {
    if (!doc.pdfUrl) return { estado: 'fallo', motivo: 'sin-pdfUrl' };

    const nombreBase = nombreDescriptivo(doc);
    const rutaBase = join(this.outDir, nombreBase);

    // Idempotencia (R-12): si ya existe un archivo válido para este doc, no re-descargar.
    if (existsSync(rutaBase) && statSync(rutaBase).size > 0) {
      const head = await readFile(rutaBase).then((b) => b.subarray(0, 4).toString('latin1'));
      if (head === '%PDF') return { estado: 'skip', ruta: rutaBase };
    }

    const ruta = join(this.outDir, nombreUnico(nombreBase, this.taken));
    const parcial = `${ruta}.part`;

    let resp: { status: number; headers: Record<string, string>; body: Buffer };
    try {
      resp = await this.fetchPdf(doc.pdfUrl);
    } catch (err) {
      return { estado: 'fallo', motivo: err instanceof Error ? err.message : String(err) };
    }

    if (resp.status !== 200) return { estado: 'fallo', motivo: `status-${resp.status}` };
    if (!esPdfValido(resp.body)) return { estado: 'fallo', motivo: 'not-a-pdf' };

    // Escritura atómica: a .part y rename al validar (nunca un .pdf final a medias).
    try {
      await mkdir(this.outDir, { recursive: true });
      await writeFile(parcial, resp.body);
      await rename(parcial, ruta);
    } catch (err) {
      await rm(parcial, { force: true }).catch(() => undefined);
      throw new DiskWriteFailed(err instanceof Error ? err.message : String(err));
    }

    return { estado: 'ok', ruta, bytes: resp.body.length };
  }
}

/** Hash corto útil para trazabilidad/deduplicación de contenidos (no usado en el nombre). */
export function sha1Corto(body: Buffer): string {
  return createHash('sha1').update(body).digest('hex').slice(0, 12);
}
