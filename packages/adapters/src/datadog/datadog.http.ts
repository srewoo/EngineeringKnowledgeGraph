/**
 * Datadog HTTP helper — raw fetch with timeout, retries, and key redaction.
 *
 * No SDK. Retries on 429 / 5xx (max 2). Never retries on 401 / 403 — auth
 * issues should surface, not be masked.
 */

import { createLogger } from '@ekg/shared';

const logger = createLogger({ service: 'adapters.datadog.http' });

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 200;

export interface DatadogCreds {
  readonly apiKey: string;
  readonly appKey: string;
  readonly site: string;
}

export interface DatadogRequest {
  readonly method?: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Record<string, string | number | undefined>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface DatadogResponse {
  readonly status: number;
  readonly body: unknown;
}

export async function datadogFetch(
  creds: DatadogCreds,
  req: DatadogRequest,
): Promise<DatadogResponse> {
  const url = buildUrl(creds.site, req.path, req.query);
  const fetchImpl = req.fetchImpl ?? fetch;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 5_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, {
        method: req.method ?? 'GET',
        headers: {
          'DD-API-KEY': creds.apiKey,
          'DD-APPLICATION-KEY': creds.appKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      const parsed = safeJson(text);
      if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
        attempt += 1;
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn({ status: res.status, attempt, delay, path: req.path }, 'retrying datadog request');
        await sleep(delay);
        continue;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      if (attempt < MAX_RETRIES && !isAuthError(err)) {
        attempt += 1;
        const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        logger.warn({ attempt, delay, error: redact(errMsg(err)) }, 'datadog request errored, retrying');
        await sleep(delay);
        continue;
      }
      throw new Error(`datadog request failed: ${redact(errMsg(err))}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildUrl(site: string, path: string, query?: Record<string, string | number | undefined>): string {
  const base = `https://api.${site}`;
  const url = new URL(path, base);
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
  try { return JSON.parse(text); } catch { return text; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAuthError(_err: unknown): boolean { return false; }

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Redact anything that looks like a Datadog key from a string. */
export function redact(s: string): string {
  return s.replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]');
}
