import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypeScriptParser } from '../../src/typescript.parser.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TypeScriptParser — NestJS + hardened HTTP', () => {
  let parser: TypeScriptParser;
  let tempDir: string;
  beforeEach(() => {
    parser = new TypeScriptParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-ts-nest-'));
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function w(name: string, content: string): string {
    const dir = join(tempDir, ...name.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    const p = join(tempDir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  it('composes @Controller(prefix) with @Get/@Post method paths', () => {
    const p = w('users.controller.ts', `
      import { Controller, Get, Post } from '@nestjs/common';

      @Controller('users')
      export class UsersController {
        @Get(':id')
        getOne() { return null; }

        @Post()
        create() { return null; }
      }
    `);

    const r = parser.parseFile(p);
    const routes = r.routes.map((rt) => `${rt.method} ${rt.path}`);
    expect(routes).toContain('GET /users/:id');
    expect(routes).toContain('POST /users');
    expect(r.routes.every((rt) => rt.framework === '@nestjs/common')).toBe(true);
  });

  it('does not flag generic .get/.post calls as HTTP outbound when no client imported', () => {
    const p = w('not-http.ts', `
      const arr = [1, 2, 3];
      const head = arr.get?.(0);
      const map = new Map();
      map.get('x');
      console.log(head);
    `);

    const r = parser.parseFile(p);
    expect(r.httpCalls.length).toBe(0);
  });

  it('captures axios.get with template literal URL', () => {
    const p = w('axios-call.ts', `
      import axios from 'axios';
      const BASE = 'http://api';
      async function go() {
        await axios.get(\`\${BASE}/users/123\`);
        await axios.post('/orders', { x: 1 });
      }
    `);
    const r = parser.parseFile(p);
    const urls = r.httpCalls.map((c) => c.url);
    // Template literal becomes {var}/users/123
    expect(urls.some((u) => u.includes('/users/123'))).toBe(true);
    expect(urls).toContain('/orders');
    expect(r.httpCalls.every((c) => c.clientLibrary === 'axios')).toBe(true);
  });
});
