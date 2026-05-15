/**
 * Phase 1.6 follow-ups — multi-language env-read regex extraction.
 *
 * Each test writes a single source file, parses it via the regex parser,
 * and asserts on `parsedEnvReads` (key, kind, sourceLine).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MultiLanguageParser } from '../../src/multi.language.parser.js';

describe('MultiLanguageParser — parsedEnvReads (Phase 1.6 follow-ups)', () => {
  let parser: MultiLanguageParser;
  let tempDir: string;

  beforeEach(() => {
    parser = new MultiLanguageParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-mlenvread-'));
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function write(name: string, content: string): string {
    const dir = join(tempDir, ...name.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    const p = join(tempDir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('Python: os.getenv / os.environ / os.environ.get', async () => {
    const fp = write('p.py', [
      'import os',
      'a = os.getenv("DATABASE_URL", "")',
      'b = os.environ["REDIS_URL"]',
      'c = os.environ.get("API_KEY")',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toEqual(['API_KEY', 'DATABASE_URL', 'REDIS_URL']);
    for (const r of reads) expect(r.kind).toBe('env');
  });

  it('Java: System.getenv (env) and System.getProperty / @Value (system-property)', async () => {
    const fp = write('A.java', [
      'class A {',
      '  String a = System.getenv("DB_HOST");',
      '  String b = System.getProperty("spring.datasource.url");',
      '  @Value("${app.feature.flag}") boolean f;',
      '}',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const env = reads.filter((r) => r.kind === 'env').map((r) => r.key);
    const sysProp = reads.filter((r) => r.kind === 'system-property').map((r) => r.key);
    expect(env).toContain('DB_HOST');
    expect(sysProp).toContain('spring.datasource.url');
    expect(sysProp).toContain('app.feature.flag');
  });

  it('Kotlin: System.getenv and getenv', async () => {
    const fp = write('A.kt', [
      'fun main() {',
      '  val a = System.getenv("KAFKA_BROKERS")',
      '  val b = getenv("LOG_LEVEL")',
      '}',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toContain('KAFKA_BROKERS');
    expect(keys).toContain('LOG_LEVEL');
  });

  it('Go: os.Getenv and os.LookupEnv', async () => {
    const fp = write('main.go', [
      'package main',
      'import "os"',
      'func main() {',
      '  _ = os.Getenv("PORT")',
      '  _, _ = os.LookupEnv("STAGE")',
      '}',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toEqual(['PORT', 'STAGE']);
  });

  it('Ruby: ENV["X"] and ENV.fetch("Y")', async () => {
    const fp = write('a.rb', [
      'a = ENV["DATABASE_URL"]',
      'b = ENV.fetch("REDIS_URL")',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toEqual(['DATABASE_URL', 'REDIS_URL']);
  });

  it('records 1-based sourceLine on each read', async () => {
    const fp = write('p.py', [
      '# header',
      'import os',
      'a = os.getenv("PORT")',
    ].join('\n'));
    const reads = (await parser.parseFile(fp)).parsedEnvReads!;
    const port = reads.find((r) => r.key === 'PORT');
    expect(port?.sourceLine).toBe(3);
  });
});
