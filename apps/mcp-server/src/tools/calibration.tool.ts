/**
 * MCP Tool: calibrate (Item 5 — confidence calibration measurement)
 *
 * EKG hand-asserts edge confidence (HIGH=1.0 / MEDIUM=0.7 / LOW=0.4). This
 * tool makes that assertion falsifiable:
 *
 *   mode="sample" — draw a random, provenance-rich sample of edges in a given
 *     confidence band (endpoint names, source file/line, resolver reason) so a
 *     human or a verification agent can judge each as correct/incorrect.
 *
 *   mode="score" — given those judgements (`labels`), compute observed accuracy
 *     per band vs. the asserted score, plus Expected Calibration Error and
 *     Brier score, and a verdict. This is how we ground "avg confidence 0.8"
 *     in evidence instead of declaration.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { computeCalibration, type EdgeLabel } from '@ekg/shared';
import type { GraphQueries } from '@ekg/graph';

const bandSchema = z.enum(['HIGH', 'MEDIUM', 'LOW']);

export function registerCalibrationTool(server: McpServer, queries: GraphQueries): void {
  server.tool(
    'calibrate',
    'Measure whether asserted edge confidence (HIGH/MEDIUM/LOW) matches reality. mode="sample" returns a random, provenance-rich sample of edges in a band for you to judge correct/incorrect; mode="score" takes those labels and returns observed-vs-asserted accuracy, Expected Calibration Error, Brier score, and a verdict.',
    {
      mode: z.enum(['sample', 'score']).describe('"sample" = draw edges to judge; "score" = compute calibration from labels'),
      confidence: bandSchema.optional().describe('Band to sample (required for mode="sample").'),
      relType: z.string().regex(/^[A-Z_]+$/).optional().describe('Optional relationship type filter, e.g. CALLS_API.'),
      limit: z.number().int().min(1).max(100).default(25).describe('Sample size (mode="sample").'),
      labels: z.array(z.object({
        edgeKey: z.string(),
        confidence: bandSchema,
        correct: z.boolean(),
      })).optional().describe('Judged edges (mode="score").'),
      minPerBand: z.number().int().min(1).max(1000).default(10).describe('Min samples for a band to drive the verdict.'),
    },
    async ({ mode, confidence, relType, limit, labels, minPerBand }) => {
      try {
        if (mode === 'sample') {
          if (!confidence) {
            return errResponse('mode="sample" requires a `confidence` band (HIGH | MEDIUM | LOW).');
          }
          const edges = await queries.sampleEdgesByConfidence(confidence, limit, relType);
          return jsonResponse({
            mode,
            confidence,
            relType: relType ?? 'any',
            count: edges.length,
            instructions: 'Judge each edge correct/incorrect, then call calibrate(mode="score", labels=[{edgeKey, confidence, correct}]).',
            edges,
          });
        }
        if (!labels || labels.length === 0) {
          return errResponse('mode="score" requires a non-empty `labels` array.');
        }
        const report = computeCalibration(labels as EdgeLabel[], { minPerBand });
        return jsonResponse({ mode, ...report });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errResponse(`calibrate failed: ${message}`);
      }
    },
  );
}

function jsonResponse(payload: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function errResponse(message: string): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
