/**
 * scraper/extractor.ts — Función pura HTML → Documento[] (cheerio), parsing defensivo.
 * Spec: specs/F3_extraccion.md. Ancla: doc 01 §D-4.
 *
 * Diseño (R-15/R-20): la extracción se ANCLA en el enlace de descarga
 * `ServletDescarga?uuid=<UUID>` — el único elemento confirmado y estable del recon. Para
 * cada enlace se sube al bloque contenedor y se cosechan los campos etiquetados; todo par
 * etiqueta/valor no mapeado nominalmente va a `camposExtra`, de modo que ningún dato visible
 * se pierde (anti-criterio 6) aunque el mapeo aún no lo contemple.
 */
import * as cheerio from 'cheerio';
import type { Cheerio, CheerioAPI } from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { Documento } from '../types.js';

const RE_UUID = /ServletDescarga\?uuid=([0-9a-fA-F-]{8,})/;

/** Normaliza texto: decodifica entidades (cheerio ya lo hace), colapsa espacios, trim. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** dd/mm/yyyy → yyyy-mm-dd; si no es parseable, null. */
export function parseFecha(raw: string): string | null {
  const m = norm(raw).match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const dd = d!.padStart(2, '0');
  const mm = mo!.padStart(2, '0');
  if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
  return `${y}-${mm}-${dd}`;
}

/** Mapea una etiqueta normalizada a un campo del dominio, o null si es "extra". */
function campoDeEtiqueta(label: string): keyof Documento | null {
  const l = label
    .toLowerCase()
    .replace(/[:.]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/(n[°º]?\s*)?expediente/.test(l)) return 'expediente';
  if (/(órgano|organo|sala)/.test(l)) return 'organo';
  if (/fecha/.test(l)) return 'fecha';
  if (/tipo/.test(l)) return 'tipoResolucion';
  if (/materia/.test(l)) return 'materia';
  if (/(sumilla|resumen)/.test(l)) return 'sumilla';
  if (/partes/.test(l)) return 'partes';
  return null;
}

/** Extrae el uuid de un href u onclick que apunte al ServletDescarga. */
function uuidDeElemento($el: Cheerio<AnyNode>): string | null {
  const href = $el.attr('href') ?? '';
  const onclick = $el.attr('onclick') ?? '';
  const m = RE_UUID.exec(href) ?? RE_UUID.exec(onclick);
  return m?.[1] ?? null;
}

/** Bloque contenedor "razonable" de una resolución a partir del enlace de descarga. */
function contenedor($: CheerioAPI, $link: Cheerio<AnyNode>): Cheerio<AnyNode> {
  const bloque = $link.closest('.resolucion, tr, li, .panel');
  return bloque.length > 0 ? bloque : $link.parent();
}

/**
 * Extrae los documentos de una página de resultados. Parsing defensivo: una fila corrupta
 * produce un Documento con nulls + no rompe las demás (R-15).
 */
export function extraer(html: string): Documento[] {
  const $ = cheerio.load(html);
  const documentos: Documento[] = [];
  const vistos = new Set<string>();

  // Candidatos: cualquier elemento cuyo href/onclick apunte al ServletDescarga.
  const enlaces = $('a, input, button, [onclick]').filter((_, el) => {
    const $el = $(el);
    return uuidDeElemento($el) !== null;
  });

  enlaces.each((_, el) => {
    const $link = $(el);
    const id = uuidDeElemento($link);
    if (!id || vistos.has(id)) return;
    vistos.add(id);

    // El doc se construye con id + enlace ANTES de cosechar campos: aunque la cosecha falle,
    // el documento y su PDF nunca se pierden (R-15, anti-criterio 6). El error se anota en el
    // propio doc para que run.ts lo loguee y lo registre en el ledger (etapa 'extract').
    const doc: Documento = {
      id,
      expediente: null,
      organo: null,
      fecha: null,
      fechaTexto: null,
      tipoResolucion: null,
      materia: null,
      sumilla: null,
      partes: null,
      pdfUrl: `/jurisprudenciaweb/ServletDescarga?uuid=${id}`,
      camposExtra: {},
    };

    try {
      const bloque = contenedor($, $link);
      bloque.find('tr').each((__, tr) => {
        const celdas = $(tr).children('td, th');
        if (celdas.length >= 2) {
          const etiqueta = norm($(celdas[0]!).text());
          const valor = norm($(celdas[1]!).text());
          if (!etiqueta || !valor) return;
          asignar(doc, etiqueta, valor);
        }
      });
    } catch (e) {
      doc.camposExtra['_errorExtraccion'] = e instanceof Error ? e.message : String(e);
    }

    documentos.push(doc);
  });

  return documentos;
}

/**
 * Valida un documento contra el schema mínimo. Devuelve la lista de campos recomendados
 * ausentes (vacía = OK). run.ts la usa para loguear un warning y registrar el doc en el ledger
 * con etapa 'extract' (R-15) sin descartarlo de la salida.
 */
export function validarDocumento(doc: Documento): string[] {
  const faltan: string[] = [];
  if (!doc.expediente) faltan.push('expediente');
  if (!doc.fecha && !doc.fechaTexto) faltan.push('fecha');
  if (doc.camposExtra['_errorExtraccion']) faltan.push('extraccion');
  return faltan;
}

function asignar(doc: Documento, etiqueta: string, valor: string): void {
  const campo = campoDeEtiqueta(etiqueta);
  if (campo === 'fecha') {
    doc.fechaTexto = valor;
    doc.fecha = parseFecha(valor);
    return;
  }
  if (campo === null) {
    doc.camposExtra[norm(etiqueta).replace(/[:.]$/, '')] = valor;
    return;
  }
  // Campos de dominio de tipo string | null.
  if (
    campo === 'expediente' ||
    campo === 'organo' ||
    campo === 'tipoResolucion' ||
    campo === 'materia' ||
    campo === 'sumilla' ||
    campo === 'partes'
  ) {
    doc[campo] = valor;
  }
}

/** Total de resultados declarado por el sitio, si se puede leer (para F2). */
export function extraerTotal(html: string): number | null {
  const $ = cheerio.load(html);
  const texto = norm($('#formBuscador\\:optResultado').text() || $('body').text());
  const m = texto.match(/(\d[\d.,]*)\s*(resultado|documento|registro)/i);
  if (m) return Number(m[1]!.replace(/[.,]/g, ''));
  return null;
}

/** Serializa a una línea JSONL por documento (orden de claves estable). */
export function aJsonl(docs: Documento[]): string {
  return docs.map((d) => JSON.stringify(d)).join('\n');
}

/** Escapa un valor para CSV RFC 4180. */
function csvCampo(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

/** Índice CSV con cabecera y una fila por documento (R-06). */
export function aCsv(docs: Documento[]): string {
  const cols: (keyof Documento)[] = [
    'id',
    'expediente',
    'organo',
    'fecha',
    'fechaTexto',
    'tipoResolucion',
    'materia',
    'sumilla',
    'partes',
    'pdfUrl',
  ];
  const cabecera = cols.join(',');
  const filas = docs.map((d) =>
    cols.map((c) => csvCampo(d[c] === null || d[c] === undefined ? '' : String(d[c]))).join(','),
  );
  return [cabecera, ...filas].join('\n');
}
