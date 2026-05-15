/**
 * Phase 1.6 follow-ups — TS/JS env-read AST extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypeScriptParser } from '../../src/typescript.parser.js';

describe('EnvReadParser (TS/JS)', () => {
  let parser: TypeScriptParser;
  let tempDir: string;

  beforeEach(() => {
    parser = new TypeScriptParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-envread-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(name: string, content: string): string {
    const filePath = join(tempDir, name);
    mkdirSync(join(tempDir, ...name.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  it('captures process.env.FOO with HIGH confidence and an enclosing function', () => {
    const fp = write('a.ts', `
      export function loadDb() {
        const url = process.env.DATABASE_URL;
        return url;
      }
    `);
    const result = parser.parseFile(fp);
    expect(result.parsedEnvReads).toBeDefined();
    const reads = result.parsedEnvReads!;
    const hit = reads.find((r) => r.key === 'DATABASE_URL');
    expect(hit).toBeTruthy();
    expect(hit!.confidence).toBe('HIGH');
    expect(hit!.kind).toBe('env');
    expect(hit!.callerSymbolId).toMatch(/^fn:.*loadDb:/);
  });

  it('captures process.env["FOO"] and process.env[\'FOO\'] bracket access', () => {
    const fp = write('b.ts', `
      const a = process.env["API_KEY"];
      const b = process.env['JWT_SECRET'];
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toEqual(['API_KEY', 'JWT_SECRET']);
    for (const r of reads) expect(r.confidence).toBe('HIGH');
  });

  it('resolves process.env[CONST] when CONST is a same-file string-literal binding (MEDIUM)', () => {
    const fp = write('c.ts', `
      const KEY = 'REDIS_URL';
      export function f() { return process.env[KEY]; }
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    const hit = reads.find((r) => r.key === 'REDIS_URL');
    expect(hit).toBeTruthy();
    expect(hit!.confidence).toBe('MEDIUM');
  });

  it('skips process.env[unknownConst] when binding cannot be resolved', () => {
    const fp = write('d.ts', `
      function f(opts: { name: string }) {
        return process.env[opts.name];
      }
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    expect(reads).toHaveLength(0);
  });

  it('captures Bun.env.FOO and Deno.env.get("FOO")', () => {
    const fp = write('e.ts', `
      const a = Bun.env.PORT;
      const b = Deno.env.get('NODE_ENV');
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    const keys = reads.map((r) => r.key).sort();
    expect(keys).toEqual(['NODE_ENV', 'PORT']);
  });

  it('captures Deno.env.toObject().FOO chained access', () => {
    const fp = write('f.ts', `
      const env = Deno.env.toObject().STAGE;
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    expect(reads.find((r) => r.key === 'STAGE')).toBeTruthy();
  });

  it('records caller as method id when read site is inside a class method', () => {
    const fp = write('g.ts', `
      export class Loader {
        public load() { return process.env.SECRET_TOKEN; }
      }
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    const hit = reads.find((r) => r.key === 'SECRET_TOKEN');
    expect(hit?.callerSymbolId).toMatch(/^method:cls:.*Loader:.*:load:/);
  });

  it('does not match lowercase or invalid env names', () => {
    const fp = write('h.ts', `
      const x = process.env["lowercase_no"];
      const y = process.env.alsoLower;
    `);
    const reads = parser.parseFile(fp).parsedEnvReads!;
    expect(reads).toHaveLength(0);
  });
});
