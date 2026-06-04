/**
 * MCP Tool: coverage_report (Item 4 — provenance / per-extractor coverage)
 *
 * Answers "what fraction of the graph do we actually know about?" rather than
 * just "what's in the graph". For every Service it checks whether each major
 * extracted kind is present (API / Database / Table / Owner / Topic / Doc),
 * aggregates into "fraction of services with X", lists services we know
 * nothing structural about, and flags Tables with no provenance (no source
 * file and no Migration link) per llmPLAN §8.
 *
 * This turns "we have the data" into "we know what we're missing" — the
 * signal an operator uses to decide which extractor to invest in next.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GraphQueries } from '@ekg/graph';

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Number((n / total).toFixed(4));
}

export function registerCoverageReportTool(server: McpServer, queries: GraphQueries): void {
  server.tool(
    'coverage_report',
    'Provenance & extractor coverage. Reports the fraction of services that have API / Database / Table / Owner / Topic / Doc nodes attached, lists services with no structural data, flags Tables lacking provenance, and gives node counts per label. Use it to find extraction gaps ("we know what we are missing").',
    {},
    async () => {
      try {
        const c = await queries.provenanceCoverage();
        const t = c.totalServices;
        const report = {
          totalServices: t,
          serviceCoverage: {
            api: { count: c.withApi, fraction: pct(c.withApi, t) },
            database: { count: c.withDatabase, fraction: pct(c.withDatabase, t) },
            table: { count: c.withTable, fraction: pct(c.withTable, t) },
            owner: { count: c.withOwner, fraction: pct(c.withOwner, t) },
            topic: { count: c.withTopic, fraction: pct(c.withTopic, t) },
            doc: { count: c.withDoc, fraction: pct(c.withDoc, t) },
          },
          servicesMissingAllStructure: {
            count: c.servicesMissingAll.length,
            sample: c.servicesMissingAll.slice(0, 25),
          },
          tableProvenance: {
            total: c.tablesTotal,
            withoutProvenance: c.tablesWithoutProvenance,
            provenanceRate: pct(c.tablesTotal - c.tablesWithoutProvenance, c.tablesTotal),
          },
          nodeCountsByLabel: c.nodeCountsByLabel,
        };
        return { content: [{ type: 'text' as const, text: JSON.stringify(report, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: `coverage_report failed: ${message}` }],
          isError: true,
        };
      }
    },
  );
}
