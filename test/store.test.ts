import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileStore, estadoInicial } from '../src/state/store.js';
import type { FalloDescarga } from '../src/types.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const fallo = (partial: Partial<FalloDescarga>): FalloDescarga => ({
  id: 'd1',
  url: 'u',
  etapa: 'descarga',
  motivo: '429-exhausted',
  intentos: 1,
  timestamp: '2026-01-01T00:00:00Z',
  ...partial,
});

describe('FileStore estado (R-12)', () => {
  it('roundtrip guardar/cargar', async () => {
    const s = new FileStore(dir);
    const e = estadoInicial({ anio: 2024 });
    e.ultimaPaginaCompletada = 3;
    e.idsProcesados = ['a', 'b'];
    await s.guardarEstado(e);
    const leido = await s.cargarEstado();
    expect(leido?.ultimaPaginaCompletada).toBe(3);
    expect(leido?.idsProcesados).toEqual(['a', 'b']);
  });

  it('cargar sin archivo → null (arranque limpio)', async () => {
    expect(await new FileStore(dir).cargarEstado()).toBeNull();
  });

  it('no deja archivo .tmp tras guardar (escritura atómica)', async () => {
    const s = new FileStore(dir);
    await s.guardarEstado(estadoInicial({}));
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    expect(existsSync(join(dir, 'state.json.tmp'))).toBe(false);
  });

  it('state.json corrupto → respaldo .corrupt + null', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{ esto no es json');
    const s = new FileStore(dir);
    expect(await s.cargarEstado()).toBeNull();
    expect(existsSync(join(dir, 'state.json.corrupt'))).toBe(true);
  });
});

describe('FileStore ledger (R-10)', () => {
  it('registra y lee un fallo', async () => {
    const s = new FileStore(dir);
    await s.registrarFallo(fallo({}));
    const fallos = await s.leerFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0]?.id).toBe('d1');
  });

  it('no duplica por (id, etapa): acumula intentos', async () => {
    const s = new FileStore(dir);
    await s.registrarFallo(fallo({ intentos: 1 }));
    await s.registrarFallo(fallo({ intentos: 1 }));
    const fallos = await s.leerFallos();
    expect(fallos).toHaveLength(1);
    expect(fallos[0]?.intentos).toBe(2);
  });

  it('distingue etapas distintas del mismo id', async () => {
    const s = new FileStore(dir);
    await s.registrarFallo(fallo({ etapa: 'descarga' }));
    await s.registrarFallo(fallo({ etapa: 'extract' }));
    expect(await s.leerFallos()).toHaveLength(2);
  });

  it('quitarFallo elimina la entrada resuelta', async () => {
    const s = new FileStore(dir);
    await s.registrarFallo(fallo({}));
    await s.quitarFallo('d1', 'descarga');
    expect(await s.leerFallos()).toHaveLength(0);
  });

  it('leer ledger inexistente → []', async () => {
    expect(await new FileStore(dir).leerFallos()).toEqual([]);
  });
});
