import { describe, it, expect } from 'vitest';
import { parseConfig, ConfigError, DEFAULTS } from '../src/config.js';

describe('parseConfig (R-17)', () => {
  it('defaults sin flags ni env', () => {
    const c = parseConfig([]);
    expect(c.comando).toBe('scrape');
    expect(c.minIntervalMs).toBe(DEFAULTS.minIntervalMs);
    expect(c.maxLimit).toBeNull();
    expect(c.resume).toBe(true);
  });

  it('CLI gana sobre env (precedencia)', () => {
    const c = parseConfig(['--min-interval', '3000'], { MIN_INTERVAL_MS: '5000' });
    expect(c.minIntervalMs).toBe(3000);
  });

  it('env aplica cuando no hay flag', () => {
    const c = parseConfig([], { MIN_INTERVAL_MS: '5000' });
    expect(c.minIntervalMs).toBe(5000);
  });

  it('--limit y --pages', () => {
    const c = parseConfig(['--limit', '10', '--pages', '2']);
    expect(c.maxLimit).toBe(10);
    expect(c.maxPages).toBe(2);
  });

  it('retry-failed como comando', () => {
    expect(parseConfig(['retry-failed']).comando).toBe('retry-failed');
    expect(parseConfig(['--retry-failed']).comando).toBe('retry-failed');
  });

  it('flags booleanos: --dry-run, --no-resume', () => {
    const c = parseConfig(['--dry-run', '--no-resume']);
    expect(c.dryRun).toBe(true);
    expect(c.resume).toBe(false);
  });

  it('valor numérico inválido → ConfigError', () => {
    expect(() => parseConfig(['--limit', 'abc'])).toThrow(ConfigError);
  });

  it('valor negativo → ConfigError', () => {
    expect(() => parseConfig(['--min-interval', '-5'])).toThrow(ConfigError);
  });

  it('argumento desconocido → ConfigError', () => {
    expect(() => parseConfig(['basura'])).toThrow(ConfigError);
  });

  it('log-level inválido cae al default', () => {
    expect(parseConfig(['--log-level', 'ruidoso']).logLevel).toBe(DEFAULTS.logLevel);
  });
});
