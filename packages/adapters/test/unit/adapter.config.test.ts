import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  adapterConfigSchema,
  adapterConfigArraySchema,
  expandEnvRefs,
  loadAdapterConfig,
} from '../../src/adapter.config.js';

describe('adapterConfigSchema', () => {
  it('parses a minimal valid entry with defaults', () => {
    const r = adapterConfigSchema.parse({
      id: 'datadog',
      capabilities: ['metrics'],
    });
    expect(r.enabled).toBe(false);
    expect(r.transport).toBe('stdio');
    expect(r.serviceMapping).toBe('auto');
    expect(r.priority).toBe(0);
  });

  it('parses pattern-based serviceMapping', () => {
    const r = adapterConfigSchema.parse({
      id: 'splunk',
      capabilities: ['logs'],
      serviceMapping: { field: 'index', pattern: 'app-{service}' },
    });
    expect(r.serviceMapping).toEqual({ field: 'index', pattern: 'app-{service}' });
  });

  it('rejects unknown keys (.strict)', () => {
    const r = adapterConfigSchema.safeParse({
      id: 'datadog',
      capabilities: ['metrics'],
      bogus: true,
    });
    expect(r.success).toBe(false);
  });

  it('rejects missing id', () => {
    const r = adapterConfigSchema.safeParse({ capabilities: ['logs'] });
    expect(r.success).toBe(false);
  });

  it('parses an array of adapter configs', () => {
    const r = adapterConfigArraySchema.parse([
      { id: 'a', capabilities: ['metrics'] },
      { id: 'b', capabilities: ['logs'], enabled: true },
    ]);
    expect(r).toHaveLength(2);
  });
});

describe('expandEnvRefs', () => {
  it('replaces ${VAR} from supplied env', () => {
    const out = expandEnvRefs({ DD_API_KEY: '${DD_API_KEY}' }, { DD_API_KEY: 'secret' } as NodeJS.ProcessEnv);
    expect(out['DD_API_KEY']).toBe('secret');
  });

  it('passes through literal values unchanged', () => {
    const out = expandEnvRefs({ FOO: 'bar' }, {});
    expect(out['FOO']).toBe('bar');
  });

  it('returns undefined for missing refs', () => {
    const out = expandEnvRefs({ MISSING: '${MISSING_VAR}' }, {});
    expect(out['MISSING']).toBeUndefined();
  });

  it('handles undefined envSpec', () => {
    expect(expandEnvRefs(undefined)).toEqual({});
  });
});

describe('loadAdapterConfig', () => {
  it('returns empty array when ekg.config.json absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ekg-cfg-'));
    expect(loadAdapterConfig(dir)).toEqual([]);
  });

  it('reads mcpAdapters from ekg.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ekg-cfg-'));
    writeFileSync(
      join(dir, 'ekg.config.json'),
      JSON.stringify({
        mcpAdapters: [
          { id: 'datadog', enabled: true, capabilities: ['metrics'] },
        ],
      }),
    );
    const cfg = loadAdapterConfig(dir);
    expect(cfg).toHaveLength(1);
    expect(cfg[0]?.id).toBe('datadog');
    expect(cfg[0]?.enabled).toBe(true);
  });

  it('returns [] on invalid mcpAdapters shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ekg-cfg-'));
    writeFileSync(
      join(dir, 'ekg.config.json'),
      JSON.stringify({ mcpAdapters: [{ id: 'x', capabilities: ['metrics'], unknown: 1 }] }),
    );
    expect(loadAdapterConfig(dir)).toEqual([]);
  });
});
