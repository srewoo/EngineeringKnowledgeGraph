/**
 * Loki HTTP helper — raw fetch with timeout, retries, optional Bearer + tenant.
 *
 * Loki is often deployed unauthenticated in-cluster; both `LOKI_TOKEN` and
 * `LOKI_TENANT_ID` are optional. Retries on 429/5xx (max 2). Never retries
 * on 401/403.
 */

import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'adapters.loki.http' });

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_AUTH = new Set([401, 403]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 200;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface LokiCreds {
  readonly baseUrl: string;
  readonly tenantId?: string;
  readonly token?: string;
}

export interface LokiRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface LokiResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function lokiFetch(creds: LokiCreds, req: LokiRequest): Promise<LokiResponse> {
  const url = buildUrl(creds.baseUrl, req.path, req.query);
  const fetchImpl = req.fetchImpl ?? fetch;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: buildHeaders(creds, req.body !== undefined),
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
          'retrying loki request',
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
          { attempt, delay, error: redact(errMsg(err), creds.token) },
          'loki request errored, retrying',
        );
        await sleep(delay);
        continue;
      }
      throw new Error(`loki request failed: ${redact(errMsg(err), creds.token)}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildHeaders(creds: LokiCreds, hasBody: boolean): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (hasBody) h['Content-Type'] = 'application/json';
  if (creds.token) h['Authorization'] = `Bearer ${creds.token}`;
  if (creds.tenantId) h['X-Scope-OrgID'] = creds.tenantId;
  return h;
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const url = new URL(`${trimmed}${path.startsWith('/') ? '' : '/'}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.append(k, String(v));
    }
  }
  return url.toString();
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

/** Redact bearer tokens from a string. */
export function redact(s: string, token?: string): string {
  let out = s;
  if (token && token.length > 0) {
    out = out.split(token).join('[REDACTED]');
  }
  return out.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]');
}
