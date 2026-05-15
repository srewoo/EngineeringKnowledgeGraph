/**
 * Phase 1.6 follow-ups — EnvReadResolver tests.
 */
import { describe, it, expect } from 'vitest';
import { EnvReadResolver, MAX_READS_CONFIG_EDGES } from '../../src/env.read.resolver.js';
import type { ConfigKeyNode, ParsedEnvRead } from '@ekg/shared';

const REPO = 'https://gitlab.com/acme/svc';

function ck(key: string, envScope?: string, filePath = 'helm/values.yaml'): ConfigKeyNode {
  const props: Record<string, unknown> = {
    key, repoUrl: REPO, filePath, sourceLine: 1, kind: 'HELM', isSecret: false,
  };
  if (envScope) props['envScope'] = envScope;
  return {
    id: `cfg:${REPO}:${filePath}:${key}${envScope ? '@' + envScope : ''}`,
    label: 'ConfigKey',
    name: key,
    properties: props as ConfigKeyNode['properties'],
  };
}

function read(key: string, callerSymbolId?: string, confidence: 'HIGH' | 'MEDIUM' = 'HIGH'): ParsedEnvRead {
  return {
    key,
    sourceLine: 10,
    confidence,
    kind: 'env',
    ...(callerSymbolId ? { callerSymbolId } : {}),
  };
}

describe('EnvReadResolver', () => {
  const resolver = new EnvReadResolver();

  it('emits a HIGH-confidence READS_CONFIG edge on exact match with caller', () => {
    const result = resolver.resolve({
      reads: [{ read: read('DATABASE_URL', 'fn:foo:loadDb:5'), filePath: 'src/db.ts' }],
      configKeys: [ck('DATABASE_URL')],
    });
    expect(result.relationships).toHaveLength(1);
    const edge = result.relationships[0]!;
    expect(edge.type).toBe('READS_CONFIG');
    expect(edge.sourceId).toBe('fn:foo:loadDb:5');
    expect(edge.targetId).toBe(ck('DATABASE_URL').id);
    expect(edge.confidence).toBe('HIGH');
    expect(edge.properties['key']).toBe('DATABASE_URL');
    expect(edge.properties['sourceLine']).toBe(10);
  });

  it('downgrades confidence to MEDIUM when the read was MEDIUM', () => {
    const result = resolver.resolve({
      reads: [{ read: read('REDIS_URL', 'fn:f:fetch:3', 'MEDIUM'), filePath: 'src/r.ts' }],
      configKeys: [ck('REDIS_URL')],
    });
    expect(result.relationships[0]?.confidence).toBe('MEDIUM');
  });

  it('emits one edge per matching ConfigKey when scopes differ (multi-resolution)', () => {
    const result = resolver.resolve({
      reads: [{ read: read('API_KEY', 'fn:f:f:1'), filePath: 'src/a.ts' }],
      configKeys: [ck('API_KEY', 'prod'), ck('API_KEY', 'staging')],
    });
    expect(result.relationships).toHaveLength(2);
    expect(result.resolvedCount).toBe(2);
  });

  it('drops reads with no matching ConfigKey (and counts them as unresolved)', () => {
    const result = resolver.resolve({
      reads: [{ read: read('UNMATCHED', 'fn:f:f:1'), filePath: 's.ts' }],
      configKeys: [ck('OTHER')],
    });
    expect(result.relationships).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it('drops reads without a callerSymbolId (cannot anchor an edge)', () => {
    const result = resolver.resolve({
      reads: [{ read: read('DATABASE_URL'), filePath: 'src/db.ts' }],
      configKeys: [ck('DATABASE_URL')],
    });
    expect(result.relationships).toHaveLength(0);
    expect(result.unresolvedCount).toBe(1);
  });

  it('caps emitted edges at MAX_READS_CONFIG_EDGES', () => {
    const reads = Array.from({ length: 10 }, (_, i) => ({
      read: read('K', `fn:f:f${i}:1`),
      filePath: 's.ts',
    }));
    // Synthesize many ConfigKeys all under key 'K' so each read fans out.
    const cap = MAX_READS_CONFIG_EDGES;
    const configKeys: ConfigKeyNode[] = Array.from({ length: cap }, (_, i) => ck('K', `s${i}`));
    const result = resolver.resolve({ reads, configKeys });
    expect(result.relationships.length).toBe(cap);
    expect(result.capped).toBe(true);
  });
});
