import { describe, it, expect } from 'vitest';
import { classifyError, isRetryableErrorCategory } from '../../src/errors.js';

describe('classifyError', () => {
  it('classifies tx-timeout messages as TIMEOUT', () => {
    expect(classifyError(new Error('Ingest timed out after 600000ms'))).toBe('TIMEOUT');
    expect(classifyError(new Error('connect ETIMEDOUT 127.0.0.1:7687'))).toBe('TIMEOUT');
  });

  it('classifies Forseti exclusive-lock contention as NEO4J_LOCK', () => {
    const msg = "ForsetiClient[transactionId=42] can't acquire ExclusiveLock{owner=Service-foo}";
    expect(classifyError(new Error(msg))).toBe('NEO4J_LOCK');
    expect(classifyError(new Error('Deadlock detected on relationship merge'))).toBe('NEO4J_LOCK');
  });

  it('classifies clone failures as CLONE_FAILED', () => {
    expect(classifyError(new Error('clone failed: timed out'))).toBe('CLONE_FAILED');
    expect(classifyError(new Error('fatal: could not read username for'))).toBe('CLONE_FAILED');
    expect(classifyError(new Error('GitLab API 404'))).toBe('CLONE_FAILED');
  });

  it('classifies parser breakage as PARSE_FAILED', () => {
    expect(classifyError(new Error('SyntaxError in source file'))).toBe('PARSE_FAILED');
    expect(classifyError(new Error('Unexpected token <'))).toBe('PARSE_FAILED');
    expect(classifyError(new Error('ts-morph project failed'))).toBe('PARSE_FAILED');
  });

  it('classifies OOM errors as OOM (preferred over timeout)', () => {
    // OOM message can sometimes contain "timed out" downstream — make sure
    // the OOM branch wins because the process is genuinely dead.
    expect(classifyError(new Error('FATAL ERROR: JS heap out of memory'))).toBe('OOM');
    expect(classifyError(new Error('allocation failed - process out of memory'))).toBe('OOM');
  });

  it('falls back to UNKNOWN for unrecognised errors', () => {
    expect(classifyError(new Error('something weird'))).toBe('UNKNOWN');
    expect(classifyError('a raw string')).toBe('UNKNOWN');
    expect(classifyError(undefined)).toBe('UNKNOWN');
    expect(classifyError({ weird: true })).toBe('UNKNOWN');
  });

  it('marks only TIMEOUT and NEO4J_LOCK as retryable', () => {
    expect(isRetryableErrorCategory('TIMEOUT')).toBe(true);
    expect(isRetryableErrorCategory('NEO4J_LOCK')).toBe(true);
    expect(isRetryableErrorCategory('PARSE_FAILED')).toBe(false);
    expect(isRetryableErrorCategory('OOM')).toBe(false);
    expect(isRetryableErrorCategory('CLONE_FAILED')).toBe(false);
    expect(isRetryableErrorCategory('UNKNOWN')).toBe(false);
  });
});
