/**
 * Error categorisation for ingestion-pipeline failures.
 *
 * The classifier is pure — it inspects an error's message and maps it to
 * a stable category that the bulk-ingestion retry logic and DLQ table use.
 *
 * Add new categories sparingly: callers (retry policy, DLQ counts, MCP filters)
 * branch on these strings.
 */

export const ERROR_CATEGORIES = [
  'TIMEOUT',
  'CLONE_FAILED',
  'PARSE_FAILED',
  'NEO4J_LOCK',
  'OOM',
  'UNKNOWN',
] as const;

export type ErrorCategory = typeof ERROR_CATEGORIES[number];

/** Categories that are worth retrying. Everything else is terminal. */
export const RETRYABLE_ERROR_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'TIMEOUT',
  'NEO4J_LOCK',
]);

export function isRetryableErrorCategory(category: ErrorCategory): boolean {
  return RETRYABLE_ERROR_CATEGORIES.has(category);
}

const CATEGORY_PATTERNS: ReadonlyArray<readonly [ErrorCategory, RegExp]> = [
  // OOM is checked early — it can co-occur with timeout messages.
  ['OOM', /JS heap out of memory|allocation failed|out of memory/i],
  ['NEO4J_LOCK', /ForsetiClient[\s\S]*can't acquire[\s\S]*Lock|deadlock detected/i],
  ['TIMEOUT', /timed out after \d+ms|ETIMEDOUT|operation timed out/i],
  ['CLONE_FAILED', /clone failed|fatal: could not read|GitLab API|repository not found/i],
  ['PARSE_FAILED', /SyntaxError|Unexpected token|ts-morph/i],
];

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Pure classifier. Given any thrown value, return its category.
 * Defaults to UNKNOWN — caller decides whether to retry UNKNOWNs (we don't).
 */
export function classifyError(err: unknown): ErrorCategory {
  const message = extractMessage(err);
  for (const [category, pattern] of CATEGORY_PATTERNS) {
    if (pattern.test(message)) return category;
  }
  return 'UNKNOWN';
}
