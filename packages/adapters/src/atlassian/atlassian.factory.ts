/**
 * Factory for the Atlassian adapter — Zod-validates env presence and constructs.
 *
 * Required env on enabled adapters:
 *   ATLASSIAN_BASE_URL  e.g. https://your-org.atlassian.net
 *   ATLASSIAN_EMAIL
 *   ATLASSIAN_API_TOKEN
 */

import { z } from 'zod';
import type { AdapterContext } from '../adapter.interface.js';
import { AtlassianAdapter } from './atlassian.adapter.js';

const credsSchema = z.object({
  ATLASSIAN_BASE_URL: z
    .string()
    .url('ATLASSIAN_BASE_URL must be a valid URL for the atlassian adapter'),
  ATLASSIAN_EMAIL: z.string().min(1, 'ATLASSIAN_EMAIL is required for the atlassian adapter'),
  ATLASSIAN_API_TOKEN: z
    .string()
    .min(1, 'ATLASSIAN_API_TOKEN is required for the atlassian adapter'),
});

export interface AtlassianFactoryOptions {
  readonly fetchImpl?: typeof fetch;
}

export function createAtlassianAdapter(
  ctx: AdapterContext,
  opts: AtlassianFactoryOptions = {},
): AtlassianAdapter {
  const parsed = credsSchema.safeParse(ctx.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`atlassian adapter ${ctx.id}: ${msg}`);
  }
  return new AtlassianAdapter({
    context: ctx,
    creds: {
      baseUrl: parsed.data.ATLASSIAN_BASE_URL,
      email: parsed.data.ATLASSIAN_EMAIL,
      apiToken: parsed.data.ATLASSIAN_API_TOKEN,
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
