import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extraer,
  extraerTotal,
  parseFecha,
  aJsonl,
  aCsv,
} from '../src/scraper/extractor.js';

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name: string): string => readFileSync(join(here, 'fixtures', name), 'utf8');

describe('parseFecha', () => {
  it('dd/mm/yyyy → ISO', () => expect(parseFecha('10/08/2024')).toBe('2024-08-10'));
  it('dd-mm-yyyy → ISO', () => expect(parseFecha('3-12-2023')).toBe('2023-12-03'));
  it('ilegible → null', () => expect(parseFecha('fecha ilegible')).toBeNull());
  it('mes inválido → null', () => expect(parseFecha('10/13/2024')).toBeNull());
});

describe('extraer (R-02/R-15) — fixture sintética (D-F0-1)', () => {
  const docs = extraer(fx('resultado-poblada-SINTETICA.html'));

  it('encuentra los 3 documentos por su enlace ServletDescarga', () => {
    expect(docs).toHaveLength(3);
    expect(docs.map((d) => d.id)).toEqual([
      '1d2b4adf-00bf-4a5b-ae43-55e5dd75f66e',
      '471af24a-bbf6-4792-ae80-9d42a13ff266',
      '537f0204-1b86-4200-9381-a6c5c04d098f',
    ]);
  });

  it('mapea todos los campos etiquetados del primer doc', () => {
    const d = docs[0]!;
    expect(d.expediente).toBe('00123-2024-0-1801');
    expect(d.organo).toBe('Sala Civil Permanente');
    expect(d.fecha).toBe('2024-08-10');
    expect(d.fechaTexto).toBe('10/08/2024');
    expect(d.tipoResolucion).toBe('Sentencia');
    expect(d.materia).toBe('Nulidad de acto jurídico');
    expect(d.sumilla).toBe('Recurso de casación declarado fundado.');
    expect(d.partes).toBe('GARCÍA vs. BANCO XYZ');
    expect(d.pdfUrl).toContain('uuid=1d2b4adf');
  });

  it('extrae el uuid también desde onclick (segundo doc)', () => {
    expect(docs[1]?.id).toBe('471af24a-bbf6-4792-ae80-9d42a13ff266');
    expect(docs[1]?.organo).toBe('Sala Penal Transitoria');
  });

  it('parsing defensivo: fila con fecha ilegible y campos faltantes no rompe (R-15)', () => {
    const d = docs[2]!;
    expect(d.expediente).toBe('00555-2022-0-0501');
    expect(d.fecha).toBeNull();
    expect(d.fechaTexto).toBe('fecha ilegible');
    expect(d.organo).toBeNull();
  });
});

describe('extraer — página vacía', () => {
  it('resultado-sin-sesion.html (panel vacío) → [] sin error', () => {
    expect(extraer(fx('resultado-sin-sesion.html'))).toEqual([]);
  });
});

describe('extraerTotal', () => {
  it('lee el contador del sitio', () => {
    expect(extraerTotal(fx('resultado-poblada-SINTETICA.html'))).toBe(3);
  });
});

describe('serialización (R-06)', () => {
  const docs = extraer(fx('resultado-poblada-SINTETICA.html'));
  it('JSONL: una línea válida por doc', () => {
    const lineas = aJsonl(docs).split('\n');
    expect(lineas).toHaveLength(3);
    expect(() => lineas.forEach((l) => JSON.parse(l))).not.toThrow();
  });
  it('CSV: cabecera + fila por doc, con escape RFC 4180', () => {
    const csv = aCsv(docs);
    const filas = csv.split('\n');
    expect(filas[0]).toContain('id,expediente,organo,fecha');
    expect(filas).toHaveLength(4);
    // La sumilla del primer doc no tiene comas; el campo partes "GARCÍA vs. BANCO XYZ" tampoco.
    expect(csv).toContain('1d2b4adf-00bf-4a5b-ae43-55e5dd75f66e');
  });
  it('CSV escapa comas y comillas', () => {
    const conComa = extraer(
      '<a href="/jurisprudenciaweb/ServletDescarga?uuid=aaaaaaaa-bbbb"></a>',
    );
    conComa[0]!.sumilla = 'uno, dos "tres"';
    const csv = aCsv(conComa);
    expect(csv).toContain('"uno, dos ""tres"""');
  });
});
