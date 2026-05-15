/**
 * route.classify — wraps the Phase 2.3 rule classifier so the agent can
 * re-classify mid-loop if the question's scope shifts.
 */

import { z } from 'zod';
import { classify } from '@ekg/router';
import type { AgentTool, ToolInvocationResult } from './tool.interface.js';

const inputSchema = z.object({
  question: z.string().min(1).max(2000),
});
type Input = z.infer<typeof inputSchema>;

export function buildRouteClassifyTool(): AgentTool<Input> {
  return {
    name: 'route.classify',
    description:
      'Classify a natural-language question into one of the 10 EKG question classes ' +
      '(topology, schema, code, flow, ownership, api, config, ops, history, unknown).',
    schema: inputSchema,
    jsonSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
      },
      required: ['question'],
    },
    async invoke(input: Input): Promise<ToolInvocationResult> {
      const result = classify(input.question);
      return {
        text: JSON.stringify(result, null, 2),
        seenIds: [],
        raw: result,
      };
    },
  };
}
