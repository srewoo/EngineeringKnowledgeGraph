/**
 * Atlassian HTTP helper — raw fetch with timeout, retries, Basic auth.
 *
 * Auth is `Basic base64(email:apiToken)`. Retries on 429 / 5xx (max 2).
 * Never retries on 401 / 403 — auth misconfig should surface, not be masked.
 */

import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'adapters.atlassian.http' });

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NON_RETRYABLE_AUTH = new Set([401, 403]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 200;
const DEFAULT_TIMEOUT_MS = 5_000;

export interface AtlassianCreds {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
}

export interface AtlassianRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface AtlassianResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function atlassianFetch(
  creds: AtlassianCreds,
  req: AtlassianRequest,
): Promise<AtlassianResponse> {
  const url = buildUrl(creds.baseUrl, req.path, req.query);
  const fetchImpl = req.fetchImpl ?? fetch;
  const auth = basicAuth(creds.email, creds.apiToken);
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
          'Content-Type': 'application/json',
          Accept: 'application/json',
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
          'retrying atlassian request',
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
          { attempt, delay, error: redact(errMsg(err), creds.apiToken) },
          'atlassian request errored, retrying',
        );
        await sleep(delay);
        continue;
      }
      throw new Error(`atlassian request failed: ${redact(errMsg(err), creds.apiToken)}`);
    } finally {
      clearTimeout(timer);
    }
  }
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

function basicAuth(email: string, token: string): string {
  return Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
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

/** Redact the literal API token plus base64 fragments from a string. */
export function redact(s: string, apiToken?: string): string {
  let out = s;
  if (apiToken && apiToken.length > 0) {
    out = out.split(apiToken).join('[REDACTED]');
  }
  return out
    .replace(/Basic\s+[A-Za-z0-9+/=]+/gi, 'Basic [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{20,}\b/g, (m) => (m.length >= 24 ? '[REDACTED]' : m));
}
