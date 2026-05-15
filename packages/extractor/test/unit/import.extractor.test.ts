import { describe, it, expect } from 'vitest';
import { ImportExtractor } from '../../src/import.extractor.js';
import type { ParseResult } from '@ekg/shared';

const baseParse: ParseResult = {
  filePath: 'src/index.ts',
  imports: [],
  exports: [],
  routes: [],
  httpCalls: [],
  databaseUsages: [],
  envVars: [],
};

describe('ImportExtractor', () => {
  const extractor = new ImportExtractor();
  const repoUrl = 'https://gitlab.com/acme/svc';

  it('emits a File node with correct id', () => {
    const r = extractor.extract(baseParse, repoUrl);
    const fileNode = r.nodes.find((n) => n.label === 'File');
    expect(fileNode?.id).toBe(`${repoUrl}:src/index.ts`);
  });

  it('emits IMPORTS edges to npm:* and local module ids; skips type-only', () => {
    const parse: ParseResult = {
      ...baseParse,
      imports: [
        { source: 'express', specifiers: ['Router'], isTypeOnly: false, isLocal: false },
        { source: './util', specifiers: ['helper'], isTypeOnly: false, isLocal: true },
        { source: 'react', specifiers: ['FC'], isTypeOnly: true, isLocal: false }, // skipped
      ],
    };
    const r = extractor.extract(parse, repoUrl);
    const importEdges = r.relationships.filter((rel) => rel.type === 'IMPORTS');
    expect(importEdges.length).toBe(2);
    expect(importEdges.some((e) => e.targetId === 'npm:express')).toBe(true);
    // Local module id has the file path joined onto the source
    expect(importEdges.some((e) => e.targetId.startsWith(repoUrl + ':'))).toBe(true);
  });

  it('emits Database, API, and Config nodes from parsed facts', () => {
    const parse: ParseResult = {
      ...baseParse,
      databaseUsages: [{ databaseType: 'MongoDB', detectedVia: 'sdk_import', packageName: 'mongoose' }],
      routes: [{ method: 'GET', path: '/users', handlerName: 'list', framework: 'express' }],
      envVars: ['DATABASE_URL'],
    };
    const r = extractor.extract(parse, repoUrl);

    const dbNode = r.nodes.find((n) => n.label === 'Database');
    expect(dbNode?.name).toBe('MongoDB');

    const apiNode = r.nodes.find((n) => n.label === 'API');
    expect(apiNode?.id).toBe('api:GET:/users');

    const configNode = r.nodes.find((n) => n.label === 'Config');
    expect(configNode?.name).toBe('DATABASE_URL');

    const usesEdge = r.relationships.find((rel) => rel.type === 'USES' && rel.targetId === 'db:mongodb');
    expect(usesEdge).toBeDefined();
    const exposesEdge = r.relationships.find((rel) => rel.type === 'EXPOSES');
    expect(exposesEdge?.targetId).toBe('api:GET:/users');
    const configEdge = r.relationships.find((rel) => rel.type === 'READS_CONFIG');
    expect(configEdge?.targetId).toBe('config:env:DATABASE_URL');
  });
});
