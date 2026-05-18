/**
 * MCP Tool: compare_dependencies — declared (graph) vs runtime (Datadog
 * adapter) dependencies for a single service.
 *
 * Sources:
 *   - Declared:  graph traversal — Service -[:DEPENDS_ON|CALLS|USES]-> Service|Database
 *                + cross-service HTTP edges resolved by ServiceResolver.
 *   - Runtime:   Datadog adapter exposes per-service metrics including
 *                runtime peers via the runtime registry; we read whichever
 *                provider implements `findRuntimeEvidence` for the seed
 *                service and a candidate set drawn from the graph + a
 *                user-supplied `peers` hint.
 *
 * Returns a 3-way set: overlap | declaredOnly | runtimeOnly. The agent can
 * use this to flag "service A depends on B in code but never calls it in
 * prod" or "service A talks to C in prod but C is missing from the graph".
 *
 * If no runtime provider is registered, the tool still returns the declared
 * set so callers can fall back gracefully.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Neo4jClient } from '@ekg/graph';
import type { RuntimeProviderRegistry, RuntimeSignalProvider } from '@ekg/advanced';
import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'tool.compare_dependencies' });

export interface CompareDependenciesDeps {
  readonly neo4jClient: Neo4jClient;
  readonly runtimeRegistry?: RuntimeProviderRegistry;
}

export function registerCompareDependenciesTool(
  server: McpServer,
  deps: CompareDependenciesDeps,
): void {
  server.tool(
    'compare_dependencies',
    'Compare declared (graph) dependencies of a service against runtime peers observed by registered runtime providers (e.g. Datadog APM). Returns overlap / declared-only / runtime-only sets so callers can flag drift.',
    {
      service: z.string().min(1).describe('Service name as it appears in the graph (Service.name).'),
      windowMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60).describe('Runtime lookback window in minutes (default 60).'),
      peers: z.array(z.string()).optional().describe('Optional candidate peer list to probe in runtime providers. Without it we use the declared peers as the candidate set (so we can only confirm or refute, not discover new ones).'),
      candidatesFromGraph: z.boolean().default(true).describe('Also seed runtime probes with all known Service nodes (cap 100). Disable to limit API calls.'),
    },
    async ({ service, windowMinutes, peers, candidatesFromGraph }) => {
      const session = deps.neo4jClient.getSession();
      let declared: DeclaredDep[];
      try {
        declared = await fetchDeclared(session, service);
      } finally {
        await session.close();
      }

      const declaredServices = declared.filter((d) => d.label === 'Service').map((d) => d.name);
      const declaredOther = declared.filter((d) => d.label !== 'Service');

      const runtimeProvider = pickProvider(deps.runtimeRegistry);
      const runtimeAvailable = runtimeProvider !== undefined;

      let candidates: string[] = [];
      if (peers && peers.length > 0) candidates = [...peers];
      else if (candidatesFromGraph) {
        const session2 = deps.neo4jClient.getSession();
        try {
          candidates = await fetchAllServiceNames(session2, service);
        } finally {
          await session2.close();
        }
      } else {
        candidates = declaredServices;
      }

      const runtimePeers: Array<{ name: string; observedCalls: number }> = [];
      if (runtimeProvider) {
        for (const cand of candidates.slice(0, 100)) {
          if (cand === service) continue;
          try {
            const ev = await runtimeProvider.findRuntimeEvidence?.(service, cand, windowMinutes);
            if (ev && ev.observedCalls > 0) {
              runtimePeers.push({ name: cand, observedCalls: ev.observedCalls });
            }
          } catch (err) {
            logger.debug(
              { service, peer: cand, error: err instanceof Error ? err.message : String(err) },
              'runtime probe failed (non-fatal)',
            );
          }
        }
      }

      const declaredSet = new Set(declaredServices);
      const runtimeSet = new Set(runtimePeers.map((p) => p.name));

      const overlap = declaredServices.filter((s) => runtimeSet.has(s)).map((name) => ({
        name,
        observedCalls: runtimePeers.find((p) => p.name === name)?.observedCalls ?? 0,
      }));
      const declaredOnly = declaredServices.filter((s) => !runtimeSet.has(s));
      const runtimeOnly = runtimePeers.filter((p) => !declaredSet.has(p.name));

      const result = {
        service,
        windowMinutes,
        runtimeProvider: runtimeProvider?.id ?? null,
        runtimeAvailable,
        declared: {
          services: declaredServices,
          databases: declaredOther.filter((d) => d.label === 'Database').map((d) => d.name),
          other: declaredOther.filter((d) => d.label !== 'Database').map((d) => ({ name: d.name, label: d.label })),
        },
        runtimePeers: runtimePeers.sort((a, b) => b.observedCalls - a.observedCalls),
        diff: {
          overlap,
          declaredOnly,
          runtimeOnly,
        },
        notes: buildNotes(runtimeAvailable, declaredOnly, runtimeOnly),
      };
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}

interface DeclaredDep {
  readonly name: string;
  readonly label: string;
}

async function fetchDeclared(
  session: ReturnType<Neo4jClient['getSession']>,
  serviceName: string,
): Promise<DeclaredDep[]> {
  const res = await session.run(
    `MATCH (s:Service {name: $name})-[:CALLS|DEPENDS_ON|USES|CALLS_API]->(t)
     RETURN DISTINCT coalesce(t.name, t.id) AS name, labels(t)[0] AS label`,
    { name: serviceName },
  );
  return res.records.map((r) => ({
    name: String(r.get('name') ?? ''),
    label: String(r.get('label') ?? ''),
  })).filter((d) => d.name);
}

async function fetchAllServiceNames(
  session: ReturnType<Neo4jClient['getSession']>,
  exclude: string,
): Promise<string[]> {
  const res = await session.run(
    'MATCH (s:Service) WHERE s.name <> $exclude RETURN s.name AS name LIMIT 200',
    { exclude },
  );
  return res.records.map((r) => String(r.get('name') ?? '')).filter(Boolean);
}

function pickProvider(reg: RuntimeProviderRegistry | undefined): RuntimeSignalProvider | undefined {
  if (!reg || reg.size() === 0) return undefined;
  // Prefer one with `findRuntimeEvidence`. Datadog has it.
  const list = reg.list();
  return list.find((p) => typeof p.findRuntimeEvidence === 'function') ?? list[0];
}

function buildNotes(
  runtimeAvailable: boolean,
  declaredOnly: readonly string[],
  runtimeOnly: ReadonlyArray<{ name: string; observedCalls: number }>,
): string[] {
  const out: string[] = [];
  if (!runtimeAvailable) {
    out.push('No runtime provider registered (e.g. Datadog adapter). Result lists declared deps only.');
    return out;
  }
  if (declaredOnly.length > 0) {
    out.push(`Declared but unused in window: ${declaredOnly.join(', ')}. Either dead code, low-traffic feature, or runtime window too short.`);
  }
  if (runtimeOnly.length > 0) {
    out.push(`Runtime peers missing from graph: ${runtimeOnly.map((r) => `${r.name} (${r.observedCalls} calls)`).join(', ')}. Likely an unresolved cross-service URL — try resolve_services or add an EKG service mapping.`);
  }
  if (declaredOnly.length === 0 && runtimeOnly.length === 0) {
    out.push('Declared and runtime peers match.');
  }
  return out;
}
