/**
 * Mixpanel HTTP helper — raw fetch with timeout, retries, Basic auth.
 *
 * Two auth modes:
 *   - Service account: `username:secret` Basic header (preferred).
 *   - Legacy:          api secret as `Basic base64(secret:)` (no password).
 *
 * Retries on 429/5xx (max 2). Never retries on 401/403.
 */

import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'adapters.mixpanel.http' });

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_AUTH = new Set([401, 403]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 200;
const DEFAULT_TIMEOUT_MS = 10_000;
const BASE = 'https://mixpanel.com/api/2.0/';

export interface MixpanelCreds {
  readonly projectId: string;
  /** "username:secret" form for service accounts. */
  readonly serviceAccount?: string;
  /** Legacy api secret. */
  readonly apiSecret?: string;
}

export interface MixpanelRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface MixpanelResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function mixpanelFetch(
  creds: MixpanelCreds,
  req: MixpanelRequest,
): Promise<MixpanelResponse> {
  const url = buildUrl(req.path, { ...(req.query ?? {}), project_id: creds.projectId });
  const fetchImpl = req.fetchImpl ?? fetch;
  const auth = basicAuth(creds);
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: {
          Authorization: `Basic ${auth}`,
          Accept: 'application/json',
          ...(req.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = safeJson(text);
      if (NON_RETRYABLE_AUTH.has(res.status)) {
        return { status: res.status, body: parsed };
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        attempt += 1;
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn(
          { status: res.status, attempt, delay, path: req.path },
          'retrying mixpanel request',
        );
        await sleep(delay);
        continue;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        attempt += 1;
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn(
          { attempt, delay, error: redact(errMsg(err), creds) },
          'mixpanel request errored, retrying',
        );
        await sleep(delay);
        continue;
      }
      throw new Error(`mixpanel request failed: ${redact(errMsg(err), creds)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUrl(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const cleaned = path.replace(/^\/+/, '');
  const url = new URL(cleaned, BASE);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    url.searchParams.append(k, String(v));
  }
  return url.toString();
}

function basicAuth(creds: MixpanelCreds): string {
  if (creds.serviceAccount && creds.serviceAccount.length > 0) {
    return Buffer.from(creds.serviceAccount, 'utf8').toString('base64');
  }
  if (creds.apiSecret && creds.apiSecret.length > 0) {
    return Buffer.from(`${creds.apiSecret}:`, 'utf8').toString('base64');
  }
  throw new Error('mixpanel creds missing serviceAccount or apiSecret');
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Redact service-account secret / api secret / Basic blobs from a string. */
export function redact(s: string, creds: MixpanelCreds): string {
  let out = s;
  if (creds.serviceAccount) {
    const secret = creds.serviceAccount.split(':')[1];
    if (secret && secret.length > 0) {
      out = out.split(secret).join('[REDACTED]');
    }
    out = out.split(creds.serviceAccount).join('[REDACTED]');
  }
  if (creds.apiSecret) {
    out = out.split(creds.apiSecret).join('[REDACTED]');
  }
  return out.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]');
}
