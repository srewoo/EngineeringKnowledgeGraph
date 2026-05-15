/**
 * GitLab webhook HTTP server — Node built-in `http`. No framework.
 *
 * Endpoints:
 *   GET  /health                 -> liveness
 *   POST /webhook/gitlab/push    -> validates X-Gitlab-Token + payload, enqueues
 *
 * Auth: constant-time comparison against `EKG_WEBHOOK_SECRET`.
 * Allow-list: comma-separated globs against `project.path_with_namespace`.
 *
 * Responses are JSON. The push endpoint replies 202 *before* ingestion runs
 * so GitLab does not time out (it expects ack within ~10s).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createLogger, type Logger } from '@ekg/shared';
import { gitlabPushEventSchema, shouldSkipPush, branchFromRef, repoUrlFromProject, matchesAllowList } from './schema.js';
import type { IngestQueue, IngestJobRequest } from './queue.js';

export interface ServerConfig {
  readonly port: number;
  readonly secret: string;
  readonly allowList: readonly string[];
  readonly token?: string;
  readonly queue: IngestQueue;
  readonly logger?: Logger;
}

export interface HandlerDeps {
  readonly secret: string;
  readonly allowList: readonly string[];
  readonly token?: string;
  readonly queue: IngestQueue;
  readonly logger: Logger;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB — GitLab push payloads are well under this

export function createWebhookServer(cfg: ServerConfig): Server {
  const logger = cfg.logger ?? createLogger({ service: 'ekg-webhook' });
  const deps: HandlerDeps = {
    secret: cfg.secret,
    allowList: cfg.allowList,
    queue: cfg.queue,
    logger,
    ...(cfg.token ? { token: cfg.token } : {}),
  };
  return createServer((req, res) => { void route(req, res, deps); });
}

async function route(req: IncomingMessage, res: ServerResponse, deps: HandlerDeps): Promise<void> {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && req.url === '/webhook/gitlab/push') {
      return await handleGitlabPush(req, res, deps);
    }
    return sendJson(res, 404, { error: 'not_found' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.error({ err: msg, url: req.url }, 'unhandled error in webhook route');
    return sendJson(res, 500, { error: 'internal_error' });
  }
}

export async function handleGitlabPush(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  // 1. Auth — constant-time compare on X-Gitlab-Token.
  const tokenHeader = headerString(req, 'x-gitlab-token');
  if (!tokenHeader || !secretsMatch(tokenHeader, deps.secret)) {
    deps.logger.warn({ ip: clientIp(req), hasHeader: Boolean(tokenHeader) }, 'webhook unauthorized');
    return sendJson(res, 401, { error: 'unauthorized' });
  }

  // 2. Read + size-cap body.
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    deps.logger.warn({ err: msg }, 'webhook body read failed');
    return sendJson(res, 413, { error: 'payload_too_large_or_unreadable' });
  }

  let json: unknown;
  try { json = JSON.parse(raw); }
  catch { return sendJson(res, 400, { error: 'malformed_json' }); }

  // 3. Schema validation.
  const parsed = gitlabPushEventSchema.safeParse(json);
  if (!parsed.success) {
    deps.logger.warn({ issues: parsed.error.issues.slice(0, 5) }, 'webhook payload validation failed');
    return sendJson(res, 400, { error: 'invalid_payload' });
  }
  const evt = parsed.data;

  // 4. Allow-list.
  const namespace = evt.project.path_with_namespace;
  if (!matchesAllowList(namespace, deps.allowList)) {
    deps.logger.info({ namespace }, 'webhook rejected: not in allow-list');
    return sendJson(res, 403, { error: 'repo_not_allowed', namespace });
  }

  // 5. Skip rules (branch creation, no commits, non-branch ref).
  const skip = shouldSkipPush(evt);
  if (skip.skip) {
    deps.logger.info({ namespace, ref: evt.ref, reason: skip.reason }, 'webhook skipped');
    return sendJson(res, 202, { accepted: false, skipped: true, reason: skip.reason });
  }

  // 6. Enqueue (per-repo lock, global cap). Reply 202 immediately.
  const repoUrl = repoUrlFromProject(evt.project.web_url);
  const branch = branchFromRef(evt.ref);
  const job: IngestJobRequest = {
    repoUrl,
    branch,
    commitSha: evt.after,
    ...(deps.token ? { token: deps.token } : {}),
  };
  const enq = deps.queue.enqueue(job);
  deps.logger.info({
    webhookEvent: 'push',
    repo: namespace,
    sha: evt.after,
    branch,
    accepted: enq.accepted,
    queueDepth: enq.queueDepth,
    inFlight: enq.inFlight,
  }, 'webhook event received');
  return sendJson(res, 202, { accepted: enq.accepted, repo: namespace, sha: evt.after, branch });
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error(`body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function headerString(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

function clientIp(req: IncomingMessage): string | undefined {
  const xff = headerString(req, 'x-forwarded-for');
  if (xff) return xff.split(',')[0]?.trim();
  return req.socket.remoteAddress ?? undefined;
}

/**
 * Constant-time compare. Returns false on length mismatch without leaking
 * timing. Empty configured secret is treated as a hard reject.
 */
export function secretsMatch(provided: string, configured: string): boolean {
  if (configured.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(configured, 'utf8');
  if (a.length !== b.length) {
    // still do a constant-time compare to a self-buffer to keep timing flat
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
