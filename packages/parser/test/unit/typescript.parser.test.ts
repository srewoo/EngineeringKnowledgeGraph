import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TypeScriptParser } from '../../src/typescript.parser.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

describe('TypeScriptParser', () => {
  let parser: TypeScriptParser;
  let tempDir: string;

  beforeEach(() => {
    parser = new TypeScriptParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-parser-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTestFile(name: string, content: string): string {
    const filePath = join(tempDir, name);
    const dir = join(tempDir, ...name.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  describe('import extraction', () => {
    it('should extract ES module imports', () => {
      const filePath = writeTestFile('test.ts', `
        import { Router } from 'express';
        import { UserService } from './services/user.service';
      `);
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0]?.source).toBe('express');
      expect(result.imports[0]?.isLocal).toBe(false);
      expect(result.imports[0]?.specifiers).toContain('Router');
      expect(result.imports[1]?.source).toBe('./services/user.service');
      expect(result.imports[1]?.isLocal).toBe(true);
    });

    it('should extract default imports', () => {
      const filePath = writeTestFile('test.ts', `
        import express from 'express';
      `);
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]?.specifiers).toContain('express');
    });

    it('should detect type-only imports', () => {
      const filePath = writeTestFile('test.ts', `
        import type { Request, Response } from 'express';
      `);
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]?.isTypeOnly).toBe(true);
    });

    it('should extract CommonJS require calls', () => {
      const filePath = writeTestFile('test.js', `
        const express = require('express');
        const db = require('./db');
      `);
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(2);
      expect(result.imports[0]?.source).toBe('express');
      expect(result.imports[1]?.source).toBe('./db');
      expect(result.imports[1]?.isLocal).toBe(true);
    });

    it('should handle namespace imports', () => {
      const filePath = writeTestFile('test.ts', `
        import * as path from 'node:path';
      `);
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(1);
      expect(result.imports[0]?.specifiers[0]).toContain('* as path');
    });
  });

  describe('export extraction', () => {
    it('should extract exported functions', () => {
      const filePath = writeTestFile('test.ts', `
        export function createUser(name: string) { return { name }; }
        function privateHelper() {}
      `);
      const result = parser.parseFile(filePath);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe('createUser');
      expect(result.exports[0]?.kind).toBe('function');
    });

    it('should extract exported classes', () => {
      const filePath = writeTestFile('test.ts', `
        export class UserService {
          getUser() { return null; }
        }
      `);
      const result = parser.parseFile(filePath);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.name).toBe('UserService');
      expect(result.exports[0]?.kind).toBe('class');
    });

    it('should extract exported interfaces as type-only', () => {
      const filePath = writeTestFile('test.ts', `
        export interface User { id: string; name: string; }
      `);
      const result = parser.parseFile(filePath);

      expect(result.exports).toHaveLength(1);
      expect(result.exports[0]?.kind).toBe('interface');
      expect(result.exports[0]?.isTypeOnly).toBe(true);
    });

    it('should extract exported variables', () => {
      const filePath = writeTestFile('test.ts', `
        export const MAX_RETRIES = 3;
        export const config = { port: 3000 };
      `);
      const result = parser.parseFile(filePath);

      expect(result.exports).toHaveLength(2);
      expect(result.exports[0]?.kind).toBe('variable');
    });
  });

  describe('database usage detection', () => {
    it('should detect database SDK imports', () => {
      const filePath = writeTestFile('test.ts', `
        import { Cluster } from 'couchbase';
        import mongoose from 'mongoose';
      `);
      const result = parser.parseFile(filePath);

      expect(result.databaseUsages).toHaveLength(2);
      expect(result.databaseUsages[0]?.databaseType).toBe('Couchbase');
      expect(result.databaseUsages[1]?.databaseType).toBe('MongoDB');
    });

    it('should not detect type-only database imports', () => {
      const filePath = writeTestFile('test.ts', `
        import type { Collection } from 'couchbase';
      `);
      const result = parser.parseFile(filePath);

      expect(result.databaseUsages).toHaveLength(0);
    });

    it('should detect Redis client imports', () => {
      const filePath = writeTestFile('test.ts', `
        import Redis from 'ioredis';
      `);
      const result = parser.parseFile(filePath);

      expect(result.databaseUsages).toHaveLength(1);
      expect(result.databaseUsages[0]?.databaseType).toBe('Redis');
    });
  });

  describe('environment variable extraction', () => {
    it('should extract process.env.VARIABLE patterns', () => {
      const filePath = writeTestFile('test.ts', `
        const port = process.env.PORT;
        const dbUrl = process.env.DATABASE_URL;
      `);
      const result = parser.parseFile(filePath);

      expect(result.envVars).toContain('PORT');
      expect(result.envVars).toContain('DATABASE_URL');
    });

    it('should deduplicate env vars', () => {
      const filePath = writeTestFile('test.ts', `
        const a = process.env.PORT;
        const b = process.env.PORT;
      `);
      const result = parser.parseFile(filePath);

      expect(result.envVars).toHaveLength(1);
    });
  });

  describe('route extraction', () => {
    it('should extract Express-style routes', () => {
      const filePath = writeTestFile('test.ts', `
        import express from 'express';
        const app = express();
        app.get('/users', getUsers);
        app.post('/users', createUser);
      `);
      const result = parser.parseFile(filePath);

      expect(result.routes).toHaveLength(2);
      expect(result.routes[0]?.method).toBe('GET');
      expect(result.routes[0]?.path).toBe('/users');
      expect(result.routes[1]?.method).toBe('POST');
    });
  });

  describe('edge cases', () => {
    it('should return empty result for unparseable file', () => {
      const result = parser.parseFile('/nonexistent/file.ts');

      expect(result.imports).toHaveLength(0);
      expect(result.exports).toHaveLength(0);
    });

    it('should handle empty files', () => {
      const filePath = writeTestFile('empty.ts', '');
      const result = parser.parseFile(filePath);

      expect(result.imports).toHaveLength(0);
      expect(result.exports).toHaveLength(0);
    });
  });
});
