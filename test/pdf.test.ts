import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  slug,
  nombreDescriptivo,
  nombreUnico,
  esPdfValido,
  PdfDownloader,
} from '../src/scraper/pdf.js';
import type { Documento } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const pdfReal = readFileSync(join(here, 'fixtures', 'servlet-descarga-sample.pdf'));

function doc(partial: Partial<Documento>): Documento {
  return {
    id: 'uuid-1',
    expediente: null,
    organo: null,
    fecha: null,
    fechaTexto: null,
    tipoResolucion: null,
    materia: null,
    sumilla: null,
    partes: null,
    pdfUrl: '/jurisprudenciaweb/ServletDescarga?uuid=uuid-1',
    camposExtra: {},
    ...partial,
  };
}

describe('slug (R-05)', () => {
  it('normaliza y pliega acentos', () => {
    expect(slug('Sala Civil Permanente')).toBe('sala-civil-permanente');
    expect(slug('Constitución y Función')).toBe('constitucion-y-funcion');
    expect(slug('  00123-2024  ')).toBe('00123-2024');
    expect(slug(null)).toBe('');
  });
});

describe('nombreDescriptivo (R-05)', () => {
  it('expediente_organo_fecha.pdf', () => {
    const d = doc({ expediente: '00123-2024', organo: 'Sala Civil Permanente', fecha: '2024-08-10' });
    expect(nombreDescriptivo(d)).toBe('00123-2024_sala-civil-permanente_2024-08-10.pdf');
  });
  it('omite campos vacíos sin dejar separadores sueltos', () => {
    const d = doc({ expediente: '00123-2024', organo: null, fecha: '2024-08-10' });
    expect(nombreDescriptivo(d)).toBe('00123-2024_2024-08-10.pdf');
  });
  it('fallback a documento_<uuid> si no hay metadatos', () => {
    expect(nombreDescriptivo(doc({ id: 'abc' }))).toBe('documento_abc.pdf');
  });
});

describe('nombreUnico (dedupe R-05)', () => {
  it('sufija -2, -3 ante colisión', () => {
    const taken = new Set<string>();
    expect(nombreUnico('a.pdf', taken)).toBe('a.pdf');
    expect(nombreUnico('a.pdf', taken)).toBe('a-2.pdf');
    expect(nombreUnico('a.pdf', taken)).toBe('a-3.pdf');
  });
});

describe('esPdfValido (R-04)', () => {
  it('true con %PDF real', () => expect(esPdfValido(pdfReal)).toBe(true));
  it('false con HTML de error', () =>
    expect(esPdfValido(Buffer.from('<html>error</html>'))).toBe(false));
  it('false con buffer vacío', () => expect(esPdfValido(Buffer.alloc(0))).toBe(false));
});

describe('PdfDownloader.descargar (R-04/R-05/R-12)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pdf-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('descarga y valida un PDF real (estado ok)', async () => {
    const dl = new PdfDownloader(dir, async () => ({ status: 200, headers: {}, body: pdfReal }));
    const r = await dl.descargar(doc({ expediente: '1', organo: 'sala', fecha: '2024-01-01' }));
    expect(r.estado).toBe('ok');
    if (r.estado === 'ok') {
      expect(existsSync(r.ruta)).toBe(true);
      expect(r.bytes).toBe(pdfReal.length);
    }
  });

  it('rechaza cuerpo que no es PDF (not-a-pdf) y no deja archivo', async () => {
    const dl = new PdfDownloader(dir, async () => ({
      status: 200,
      headers: {},
      body: Buffer.from('<html>sesión caída</html>'),
    }));
    const r = await dl.descargar(doc({ expediente: '1' }));
    expect(r).toEqual({ estado: 'fallo', motivo: 'not-a-pdf' });
  });

  it('skip idempotente si el PDF ya existe y es válido (sin llamar al fetcher)', async () => {
    const nombre = nombreDescriptivo(doc({ expediente: '1', organo: 'sala', fecha: '2024-01-01' }));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, nombre), pdfReal);
    let llamado = false;
    const dl = new PdfDownloader(dir, async () => {
      llamado = true;
      return { status: 200, headers: {}, body: pdfReal };
    });
    const r = await dl.descargar(doc({ expediente: '1', organo: 'sala', fecha: '2024-01-01' }));
    expect(r.estado).toBe('skip');
    expect(llamado).toBe(false);
  });

  it('un fetcher que agota reintentos (throw) → fallo, el lote no muere (R-09)', async () => {
    const dl = new PdfDownloader(dir, async () => {
      throw new Error('RetryExhausted: 429');
    });
    const r = await dl.descargar(doc({ expediente: '1' }));
    expect(r.estado).toBe('fallo');
    if (r.estado === 'fallo') expect(r.motivo).toContain('429');
  });
});
