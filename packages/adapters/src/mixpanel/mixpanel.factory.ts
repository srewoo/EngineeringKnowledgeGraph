/**
 * Factory for the Mixpanel adapter — Zod-validates env presence and constructs.
 *
 * Required env on enabled adapters:
 *   MIXPANEL_PROJECT_ID
 *   MIXPANEL_SERVICE_ACCOUNT (`username:secret`)  — preferred
 *   OR
 *   MIXPANEL_API_SECRET                            — legacy
 */

import { z } from 'zod';
import type { AdapterContext } from '../adapter.interface.js';
import { MixpanelAdapter } from './mixpanel.adapter.js';

const credsSchema = z
  .object({
    MIXPANEL_PROJECT_ID: z
      .string()
      .min(1, 'MIXPANEL_PROJECT_ID is required for the mixpanel adapter'),
    MIXPANEL_SERVICE_ACCOUNT: z.string().min(1).optional(),
    MIXPANEL_API_SECRET: z.string().min(1).optional(),
  })
  .refine(
    (v) => Boolean(v.MIXPANEL_SERVICE_ACCOUNT) || Boolean(v.MIXPANEL_API_SECRET),
    {
      message:
        'mixpanel adapter requires either MIXPANEL_SERVICE_ACCOUNT (username:secret) or MIXPANEL_API_SECRET',
    },
  );

export interface MixpanelFactoryOptions {
  readonly fetchImpl?: typeof fetch;
}

export function createMixpanelAdapter(
  ctx: AdapterContext,
  opts: MixpanelFactoryOptions = {},
): MixpanelAdapter {
  const parsed = credsSchema.safeParse(ctx.env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`mixpanel adapter ${ctx.id}: ${msg}`);
  }
  return new MixpanelAdapter({
    context: ctx,
    creds: {
      projectId: parsed.data.MIXPANEL_PROJECT_ID,
      ...(parsed.data.MIXPANEL_SERVICE_ACCOUNT
        ? { serviceAccount: parsed.data.MIXPANEL_SERVICE_ACCOUNT }
        : {}),
      ...(parsed.data.MIXPANEL_API_SECRET
        ? { apiSecret: parsed.data.MIXPANEL_API_SECRET }
        : {}),
    },
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
}
