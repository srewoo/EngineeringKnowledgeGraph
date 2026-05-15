import { describe, it, expect } from 'vitest';
import { extractServiceNames, getTemplate, listTemplates } from '../../src/cypher.templates.js';

describe('extractServiceNames', () => {
  it('extracts hyphenated service names', () => {
    expect(extractServiceNames('What services depend on person-service?')).toContain('person-service');
  });

  it('extracts service names ending in known suffixes', () => {
    expect(extractServiceNames('which kafka topic does callai-service consume?')).toContain('callai-service');
  });

  it('drops single words without hyphen or known suffix', () => {
    const out = extractServiceNames('which table stores user sessions');
    expect(out).toEqual([]);
  });

  it('dedupes repeated names', () => {
    const out = extractServiceNames('person-service depends on person-service');
    expect(out).toEqual(['person-service']);
  });

  it('returns empty array for empty input', () => {
    expect(extractServiceNames('')).toEqual([]);
  });

  it('handles multiple distinct services', () => {
    const out = extractServiceNames('does auth-api depend on user-service and billing-service?');
    expect(out).toContain('auth-api');
    expect(out).toContain('user-service');
    expect(out).toContain('billing-service');
  });
});

describe('cypher templates', () => {
  it('exposes all five strategy keys', () => {
    const all = listTemplates();
    expect(Object.keys(all).sort()).toEqual(
      ['commits', 'config', 'kafka', 'ownership', 'topology'].sort(),
    );
  });

  it('topology template references DEPENDS_ON traversal', () => {
    expect(getTemplate('topology').cypher).toMatch(/DEPENDS_ON/);
    expect(getTemplate('topology').cypher).toMatch(/\$serviceNames/);
  });

  it('ownership template references OWNS edge', () => {
    expect(getTemplate('ownership').cypher).toMatch(/OWNS/);
  });

  it('config template references READS_CONFIG edge', () => {
    expect(getTemplate('config').cypher).toMatch(/READS_CONFIG/);
  });

  it('kafka template covers PRODUCES and CONSUMES', () => {
    const c = getTemplate('kafka').cypher;
    expect(c).toMatch(/PRODUCES/);
    expect(c).toMatch(/CONSUMES/);
  });

  it('commits template references TOUCHED edges and Commit nodes', () => {
    const c = getTemplate('commits').cypher;
    expect(c).toMatch(/TOUCHED/);
    expect(c).toMatch(/:Commit/);
    expect(c).toMatch(/\$entity/);
    expect(c).toMatch(/\$serviceNames/);
    expect(c).toMatch(/ORDER BY c\.authoredAt DESC/);
    expect(c).toMatch(/LIMIT 20/);
  });

  it('all templates parameterise inputs (no string concat)', () => {
    for (const t of Object.values(listTemplates())) {
      expect(t.cypher).not.toMatch(/\+\s*['"]/);
    }
  });
});
