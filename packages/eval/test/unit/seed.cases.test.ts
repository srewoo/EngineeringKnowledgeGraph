import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { loadCasesFromFile } from '../../src/cases.loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = resolve(here, '..', '..', 'cases', 'seed.cases.json');

describe('seed eval cases', () => {
  const cases = loadCasesFromFile(seedPath);

  it('contains exactly 20 cases', () => {
    expect(cases).toHaveLength(20);
  });

  it('uses unique ids', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all 9 question classes', () => {
    const classes = new Set(cases.map((c) => c.expectedClass));
    for (const cls of [
      'topology', 'schema', 'code', 'flow', 'api',
      'ownership', 'config', 'ops', 'history',
    ] as const) {
      expect(classes.has(cls), `missing class ${cls}`).toBe(true);
    }
  });

  it('every case has at least one gold citation', () => {
    for (const c of cases) {
      expect(c.goldCitations.length, `case ${c.id} has no citations`).toBeGreaterThan(0);
    }
  });
});
