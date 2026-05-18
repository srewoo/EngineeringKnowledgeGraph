/**
 * Adapter config loader — reads `mcpAdapters[]` from `ekg.config.json`,
 * validates with Zod, and expands `${VAR}` env references.
 *
 * Missing env vars on enabled adapters are logged as warnings (not thrown)
 * so partial configs degrade gracefully.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'adapters.config' });

export const adapterCapabilitySchema = z.enum([
  'metrics',
  'traces',
  'errors',
  'logs',
  'docs',
  'tickets',
  'usage',
  'alarms',
]);

export const serviceMappingSchema = z.union([
  z.literal('auto'),
  z.object({ field: z.string(), pattern: z.string() }).strict(),
]);

export const adapterConfigSchema = z
  .object({
    id: z.string().min(1),
    enabled: z.boolean().default(false),
    transport: z.enum(['stdio', 'sse', 'http']).default('stdio'),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional(),
    serviceMapping: serviceMappingSchema.default('auto'),
    capabilities: z.array(adapterCapabilitySchema),
    priority: z.number().default(0),
    config: z.record(z.unknown()).optional(),
  })
  .strict();

export const adapterConfigArraySchema = z.array(adapterConfigSchema);

export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

const ENV_REF = /^\$\{([A-Z0-9_]+)\}$/;

export function expandEnvRefs(
  envSpec: Record<string, string> | undefined,
  processEnv: NodeJS.ProcessEnv = process.env,
  opts: { adapterId?: string; enabled?: boolean } = {},
): Record<string, string | undefined> {
  if (!envSpec) return {};
  const result: Record<string, string | undefined> = {};
  for (const [key, raw] of Object.entries(envSpec)) {
    const match = ENV_REF.exec(raw);
    if (!match) {
      result[key] = raw;
      continue;
    }
    const varName = match[1]!;
    const resolved = processEnv[varName];
    if (resolved === undefined && opts.enabled) {
      logger.warn(
        { adapter: opts.adapterId, envKey: key, ref: varName },
        'env reference unresolved for enabled adapter',
      );
    }
    result[key] = resolved;
  }
  return result;
}

export function loadAdapterConfig(repoRoot: string): AdapterConfig[] {
  const path = join(repoRoot, 'ekg.config.json');
  if (!existsSync(path)) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    logger.warn({ path, error: errMsg(err) }, 'failed to parse ekg.config.json');
    return [];
  }
  const adapters = (parsed as { mcpAdapters?: unknown })?.mcpAdapters;
  if (!adapters) return [];
  const result = adapterConfigArraySchema.safeParse(adapters);
  if (!result.success) {
    logger.warn({ issues: result.error.issues }, 'invalid mcpAdapters config');
    return [];
  }
  return result.data;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
