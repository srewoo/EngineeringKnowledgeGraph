/**
 * Factory for the Loki adapter — Zod-validates env presence and constructs.
 *
 * Required env on enabled adapters:
 *   LOKI_BASE_URL
 *   LOKI_TENANT_ID  (optional)
 *   LOKI_TOKEN      (optional — many in-cluster Loki deployments are unauth)
 */

import { z } from 'zod';
import type { AdapterContext } from '../adapter.interface.js';
import { LokiAdapter } from './loki.adapter.js';

const credsSchema = z.object({
  LOKI_BASE_URL: z.string().url('LOKI_BASE_URL must be a valid URL for the loki adapter'),
  LOKI_TENANT_ID: z.string().min(1).optional(),
  LOKI_TOKEN: z.string().min(1).optional(),
});

export interface LokiFactoryOptions {
  readonly fetchImpl?: typeof fetch;
}

export function createLokiAdapter(
  ctx: AdapterContext,
  opts: LokiFactoryOptions = {},
): LokiAdapter {
  const parsed = credsSchema.safeParse(ctx.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`loki adapter ${ctx.id}: ${msg}`);
  }
  return new LokiAdapter({
    context: ctx,
    creds: {
      baseUrl: parsed.data.LOKI_BASE_URL,
      ...(parsed.data.LOKI_TENANT_ID ? { tenantId: parsed.data.LOKI_TENANT_ID } : {}),
      ...(parsed.data.LOKI_TOKEN ? { token: parsed.data.LOKI_TOKEN } : {}),
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
