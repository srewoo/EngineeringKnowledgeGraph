import { describe, it, expect } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCompareDependenciesTool } from '../../src/tools/compare-dependencies.tool.js';
import { RuntimeProviderRegistry } from '@ekg/advanced';
import type { Neo4jClient } from '@ekg/graph';
import type { RuntimeSignalProvider, RuntimeEdgeEvidence } from '@ekg/advanced';

function record(values: Record<string, unknown>) {
  return { get: (k: string) => values[k] };
}

interface FakeRunResult { records: Array<{ get: (k: string) => unknown }> }

function fakeNeo4j(plan: Record<string, FakeRunResult>): Neo4jClient {
  return {
    getSession() {
      return {
        async run(cypher: string) {
          for (const [needle, res] of Object.entries(plan)) {
            if (cypher.includes(needle)) return res;
          }
          return { records: [] };
        },
        async close() { /* noop */ },
      };
    },
  } as unknown as Neo4jClient;
}

function getHandler(neo4j: Neo4jClient, registry?: RuntimeProviderRegistry) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCompareDependenciesTool(server, {
    neo4jClient: neo4j,
    ...(registry ? { runtimeRegistry: registry } : {}),
  });
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })._registeredTools['compare_dependencies'];
  if (!reg) throw new Error('compare_dependencies not registered');
  return reg.handler;
}

describe('compare_dependencies', () => {
  it('returns declared deps only when no runtime registry is wired', async () => {
    const neo4j = fakeNeo4j({
      'DEPENDS_ON|USES': {
        records: [
          record({ name: 'auth-service', label: 'Service' }),
          record({ name: 'postgres', label: 'Database' }),
        ],
      },
      'MATCH (s:Service) WHERE s.name <> $exclude': { records: [] },
    });
    const handler = getHandler(neo4j);
    const res = (await handler({ service: 'orders', windowMinutes: 60, candidatesFromGraph: true })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text);
    expect(out.runtimeAvailable).toBe(false);
    expect(out.declared.services).toEqual(['auth-service']);
    expect(out.declared.databases).toEqual(['postgres']);
    // No runtime provider → everything declared is "declaredOnly".
    expect(out.diff.declaredOnly).toEqual(['auth-service']);
    expect(out.notes.join(' ')).toMatch(/no runtime provider/i);
  });

  it('flags declaredOnly and runtimeOnly drift when a runtime provider is available', async () => {
    const neo4j = fakeNeo4j({
      'DEPENDS_ON|USES': {
        records: [
          record({ name: 'auth-service', label: 'Service' }),
          record({ name: 'unused-service', label: 'Service' }),
        ],
      },
      'MATCH (s:Service) WHERE s.name <> $exclude': {
        records: [
          record({ name: 'auth-service' }),
          record({ name: 'unused-service' }),
          record({ name: 'analytics-service' }),
        ],
      },
    });

    const fakeProvider: RuntimeSignalProvider = {
      id: 'datadog-fake',
      capabilities: ['traces'],
      async healthCheck() { return true; },
      async findRuntimeEvidence(a: string, b: string): Promise<RuntimeEdgeEvidence> {
        const peer = (n: number) => ({ serviceA: a, serviceB: b, observedCalls: n, sample: [] });
        if (b === 'auth-service') return peer(123);
        if (b === 'analytics-service') return peer(7);
        return peer(0);
      },
    };
    const registry = new RuntimeProviderRegistry();
    registry.register(fakeProvider);

    const handler = getHandler(neo4j, registry);
    const res = (await handler({ service: 'orders', windowMinutes: 60, candidatesFromGraph: true })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text);
    expect(out.runtimeAvailable).toBe(true);
    expect(out.runtimeProvider).toBe('datadog-fake');
    expect(out.diff.overlap.map((o: { name: string }) => o.name)).toEqual(['auth-service']);
    expect(out.diff.declaredOnly).toEqual(['unused-service']);
    expect(out.diff.runtimeOnly.map((r: { name: string }) => r.name)).toEqual(['analytics-service']);
  });

  it('uses user-provided peers list when supplied', async () => {
    const neo4j = fakeNeo4j({
      'DEPENDS_ON|USES': { records: [] },
      'MATCH (s:Service) WHERE s.name <> $exclude': { records: [] },
    });
    const fakeProvider: RuntimeSignalProvider = {
      id: 'dd',
      capabilities: ['traces'],
      async healthCheck() { return true; },
      async findRuntimeEvidence(a: string, b: string): Promise<RuntimeEdgeEvidence> {
        return { serviceA: a, serviceB: b, observedCalls: b === 'svc-x' ? 5 : 0, sample: [] };
      },
    };
    const registry = new RuntimeProviderRegistry();
    registry.register(fakeProvider);

    const handler = getHandler(neo4j, registry);
    const res = (await handler({
      service: 'orders',
      windowMinutes: 60,
      peers: ['svc-x', 'svc-y'],
      candidatesFromGraph: false,
    })) as { content: { text: string }[] };
    const out = JSON.parse(res.content[0]!.text);
    expect(out.runtimePeers.map((p: { name: string }) => p.name)).toEqual(['svc-x']);
    expect(out.diff.runtimeOnly.map((r: { name: string }) => r.name)).toEqual(['svc-x']);
  });
});
