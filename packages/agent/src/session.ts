/**
 * Session adapter — maps between the agent's in-memory conversation state and
 * the SQLite-backed `AgentSessionRepository`. The repository lives in
 * `@ekg/storage`; this file owns the JSON shape and the size/turn caps.
 *
 * Caps:
 *  - `EKG_AGENT_MAX_TURNS_PER_SESSION` (default 20) — total user turns ever
 *    submitted to the session. Overflow → caller refuses.
 *  - 32KB serialised messages — when exceeded, the oldest tool-result messages
 *    are dropped first, preserving the system header context and the most
 *    recent 5 messages.
 */

import type { Message } from './provider.interface.js';

export const SESSION_DEFAULT_MAX_TURNS = 20;
export const SESSION_MAX_BYTES = 32 * 1024;
const RECENT_TAIL_KEEP = 5;

export interface SessionState {
  /** Messages from prior turns (assistant + tool + user, in order). */
  readonly messages: readonly Message[];
  /** Citation IDs already produced by tools in prior turns. */
  readonly seenIds: readonly string[];
  /** Free-form metadata (repo, classification, running totals). */
  readonly metadata: SessionMetadata;
}

export interface SessionMetadata {
  readonly repo?: string;
  readonly classification?: string;
  readonly tokensUsedTotal?: number;
  readonly turnCount?: number;
}

export interface SessionRepoLike {
  get(sessionId: string): { messages: string; seenIds: string; metadata: string | undefined } | undefined;
  update(sessionId: string, fields: { messages?: string; seenIds?: string; metadata?: string }): void;
}

export function loadSession(repo: SessionRepoLike, sessionId: string): SessionState | undefined {
  const row = repo.get(sessionId);
  if (!row) return undefined;
  return {
    messages: parseJsonArray<Message>(row.messages),
    seenIds: parseJsonArray<string>(row.seenIds),
    metadata: row.metadata ? safeParseObject<SessionMetadata>(row.metadata) : {},
  };
}

export function saveSession(
  repo: SessionRepoLike,
  sessionId: string,
  state: SessionState,
): void {
  const trimmed = enforceByteCap(state.messages);
  repo.update(sessionId, {
    messages: JSON.stringify(trimmed),
    seenIds: JSON.stringify(Array.from(new Set(state.seenIds))),
    metadata: JSON.stringify(state.metadata ?? {}),
  });
}

/**
 * Drop oldest tool-result messages until serialised size fits SESSION_MAX_BYTES.
 * Preserve the most recent RECENT_TAIL_KEEP messages.
 */
export function enforceByteCap(messages: readonly Message[]): Message[] {
  let working = [...messages];
  let bytes = Buffer.byteLength(JSON.stringify(working), 'utf8');
  if (bytes <= SESSION_MAX_BYTES) return working;

  // Determine the protected tail.
  const tailStart = Math.max(0, working.length - RECENT_TAIL_KEEP);
  // Drop oldest tool messages first.
  for (let i = 0; i < tailStart && bytes > SESSION_MAX_BYTES; ) {
    if (working[i]?.role === 'tool') {
      working.splice(i, 1);
    } else {
      i += 1;
    }
    bytes = Buffer.byteLength(JSON.stringify(working), 'utf8');
  }
  // Still too big? Drop oldest non-tail messages regardless of role.
  while (bytes > SESSION_MAX_BYTES && working.length > RECENT_TAIL_KEEP) {
    working.shift();
    bytes = Buffer.byteLength(JSON.stringify(working), 'utf8');
  }
  return working;
}

export function readMaxTurns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env['EKG_AGENT_MAX_TURNS_PER_SESSION']);
  if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
  return SESSION_DEFAULT_MAX_TURNS;
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function safeParseObject<T>(raw: string): T {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}
