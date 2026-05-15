/**
 * Factory for the Datadog adapter — validates env presence and constructs.
 *
 * Throws a clean error if required keys are missing AND the adapter is enabled.
 * The bootstrap layer catches and marks the adapter unhealthy.
 */

import { z } from 'zod';
import type { AdapterContext } from '../adapter.interface.js';
import type { ServiceMapping } from '../service.mapping.js';
import { DatadogAdapter } from './datadog.adapter.js';

const credsSchema = z.object({
  DD_API_KEY: z.string().min(1, 'DD_API_KEY is required for the datadog adapter'),
  DD_APP_KEY: z.string().min(1, 'DD_APP_KEY is required for the datadog adapter'),
  DD_SITE: z.string().min(1).optional(),
});

export interface DatadogFactoryOptions {
  readonly serviceMapping?: ServiceMapping;
  readonly fetchImpl?: typeof fetch;
}

export function createDatadogAdapter(
  ctx: AdapterContext,
  opts: DatadogFactoryOptions = {},
): DatadogAdapter {
  const parsed = credsSchema.safeParse(ctx.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`datadog adapter ${ctx.id}: ${msg}`);
  }
  return new DatadogAdapter({
    context: ctx,
    creds: {
      apiKey: parsed.data.DD_API_KEY,
      appKey: parsed.data.DD_APP_KEY,
      site: parsed.data.DD_SITE ?? 'datadoghq.com',
    },
    ...(opts.serviceMapping ? { serviceMapping: opts.serviceMapping } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
