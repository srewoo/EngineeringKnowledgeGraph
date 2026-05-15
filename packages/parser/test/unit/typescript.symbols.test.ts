/**
 * Phase 1.3 — function/class/method/typedef extraction.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TypeScriptParser } from '../../src/typescript.parser.js';

describe('TypeScriptParser — symbols (Phase 1.3)', () => {
  let parser: TypeScriptParser;
  let tempDir: string;

  beforeEach(() => {
    parser = new TypeScriptParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-symbols-test-'));
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

  it('extracts a JSDoc-annotated, async, exported function with complexity > 1', () => {
    const fp = write('a.ts', `
      /** Doc for foo. */
      export async function foo(x: number): Promise<number> {
        if (x > 0) return x;
        if (x < 0) return -x;
        return x && 1 || 0;
      }
    `);
    const result = parser.parseFile(fp);
    expect(result.symbols).toBeDefined();
    const fn = result.symbols!.functions.find((f) => f.name === 'foo')!;
    expect(fn).toBeTruthy();
    expect(fn.isExported).toBe(true);
    expect(fn.isAsync).toBe(true);
    expect(fn.docComment).toContain('Doc for foo');
    expect(fn.complexity).toBeGreaterThanOrEqual(3);
  });

  it('extracts an exported arrow-function const as a function', () => {
    const fp = write('arrow.ts', `
      export const greet = (name: string) => 'hi ' + name;
    `);
    const result = parser.parseFile(fp);
    const fn = result.symbols!.functions.find((f) => f.name === 'greet');
    expect(fn).toBeTruthy();
    expect(fn!.isExported).toBe(true);
  });

  it('extracts a class with methods, static, private, async, and EXTENDS another class', () => {
    const fp = write('cls.ts', `
      export class Base {}
      export class Child extends Base {
        static counter = 0;
        public async run(): Promise<void> {}
        private helper() { return 1; }
        static factory() { return new Child(); }
      }
    `);
    const result = parser.parseFile(fp);
    const child = result.symbols!.classes.find((c) => c.name === 'Child')!;
    expect(child).toBeTruthy();
    expect(child.isExported).toBe(true);
    expect(child.extendsRef).toBeDefined();
    // Same-file extends → resolved to local class id (`cls:` prefix).
    expect(child.extendsRef!.startsWith('cls:')).toBe(true);

    const methods = result.symbols!.methods.filter((m) => m.classId === child.id);
    expect(methods.map((m) => m.name).sort()).toEqual(['factory', 'helper', 'run']);
    const run = methods.find((m) => m.name === 'run')!;
    expect(run.isAsync).toBe(true);
    expect(run.visibility).toBe('public');
    const helper = methods.find((m) => m.name === 'helper')!;
    expect(helper.visibility).toBe('private');
    const factory = methods.find((m) => m.name === 'factory')!;
    expect(factory.isStatic).toBe(true);
  });

  it('extracts interface, type alias, and enum as TypeDefs', () => {
    const fp = write('types.ts', `
      export interface User { id: string }
      export type Id = string;
      export enum Color { RED, BLUE }
    `);
    const result = parser.parseFile(fp);
    const kinds = result.symbols!.typeDefs.map((t) => `${t.name}:${t.kind}`).sort();
    expect(kinds).toEqual(['Color:enum', 'Id:type-alias', 'User:interface']);
    expect(result.symbols!.typeDefs.every((t) => t.isExported)).toBe(true);
  });

  it('resolves same-file calls and emits MEDIUM-confidence import refs for unresolved', () => {
    const fp = write('calls.ts', `
      import { external } from 'lodash';
      function helper() { return 1; }
      export function caller() {
        helper();
        external();
      }
    `);
    const result = parser.parseFile(fp);
    const calls = result.symbols!.calls;
    const sourceIds = new Set(calls.map((c) => c.sourceId));
    // caller has both calls
    const callerId = result.symbols!.functions.find((f) => f.name === 'caller')!.id;
    expect(sourceIds.has(callerId)).toBe(true);

    const fromCaller = calls.filter((c) => c.sourceId === callerId);
    expect(fromCaller.some((c) => c.resolved && c.targetId.startsWith('fn:'))).toBe(true);
    const unresolved = fromCaller.find((c) => !c.resolved);
    expect(unresolved).toBeTruthy();
    expect(unresolved!.targetId).toBe('external@lodash');
  });

  it('resolves this.foo() inside a class method to the enclosing class method', () => {
    const fp = write('this.ts', `
      export class Svc {
        public a() { this.b(); }
        public b() {}
      }
    `);
    const result = parser.parseFile(fp);
    const svcId = result.symbols!.classes.find((c) => c.name === 'Svc')!.id;
    const aId = result.symbols!.methods.find((m) => m.classId === svcId && m.name === 'a')!.id;
    const bId = result.symbols!.methods.find((m) => m.classId === svcId && m.name === 'b')!.id;
    const edge = result.symbols!.calls.find((c) => c.sourceId === aId);
    expect(edge).toBeTruthy();
    expect(edge!.targetId).toBe(bId);
    expect(edge!.resolved).toBe(true);
  });

  it('emits expected counts on a small synthetic file', () => {
    const fp = write('mix.ts', `
      export interface I {}
      export class A {
        m() {}
      }
      export function f() { return 1; }
      export const g = () => 2;
    `);
    const result = parser.parseFile(fp);
    const s = result.symbols!;
    expect(s.functions).toHaveLength(2); // f, g
    expect(s.classes).toHaveLength(1);
    expect(s.methods).toHaveLength(1);
    expect(s.typeDefs).toHaveLength(1);
  });

  it('emits a USES (type) edge to a same-file TypeDef from a function parameter', () => {
    const fp = write('uses.ts', `
      export interface Req { id: string }
      export function handle(req: Req): void {}
    `);
    const result = parser.parseFile(fp);
    const fnId = result.symbols!.functions.find((f) => f.name === 'handle')!.id;
    const tdId = result.symbols!.typeDefs.find((t) => t.name === 'Req')!.id;
    const tu = result.symbols!.typeUses.find((u) => u.sourceId === fnId);
    expect(tu).toBeTruthy();
    expect(tu!.targetId).toBe(tdId);
    expect(tu!.resolved).toBe(true);
  });
});
