import { describe, it, expect } from 'vitest';
import { loadCasesFromFile, parseCases } from '../../src/cases.loader.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('cases loader', () => {
  it('loads the bundled 40-case scaffold without error', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const path = resolve(here, '..', '..', 'eval-set', 'cases.json');
    const cases = loadCasesFromFile(path);
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const classes = new Set(cases.map((c) => c.expectedClass));
    // At least all 9 classes covered
    for (const required of ['topology', 'schema', 'code', 'flow', 'ownership', 'api', 'config', 'ops', 'history']) {
      expect(classes.has(required as never)).toBe(true);
    }
  });

  it('rejects malformed cases', () => {
    expect(() => parseCases([{ id: '', question: 'q', expectedClass: 'topology', goldCitations: [] }])).toThrow();
    expect(() => parseCases([{ id: 'x', question: 'q', expectedClass: 'mystery', goldCitations: [] }])).toThrow();
  });
});
