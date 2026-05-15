import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MultiLanguageParser } from '../../src/multi.language.parser.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('MultiLanguageParser', () => {
  let parser: MultiLanguageParser;
  let tempDir: string;

  beforeEach(() => {
    parser = new MultiLanguageParser();
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-multi-test-'));
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function write(name: string, content: string): string {
    const dir = join(tempDir, ...name.split('/').slice(0, -1));
    mkdirSync(dir, { recursive: true });
    const p = join(tempDir, name);
    writeFileSync(p, content, 'utf-8');
    return p;
  }

  describe('language detection', () => {
    it('handles supported extensions', () => {
      expect(MultiLanguageParser.handles('.go')).toBe(true);
      expect(MultiLanguageParser.handles('.py')).toBe(true);
      expect(MultiLanguageParser.handles('.rs')).toBe(true);
      expect(MultiLanguageParser.handles('.java')).toBe(true);
      expect(MultiLanguageParser.handles('.ts')).toBe(false); // ts handled by ts-morph
    });
  });

  describe('Java extraction', () => {
    it('extracts imports + spring routes + db sdk + env vars', async () => {
      const path = write('UserController.java', `
        package com.acme.user;

        import org.springframework.web.bind.annotation.GetMapping;
        import org.springframework.web.bind.annotation.PostMapping;
        import org.springframework.web.bind.annotation.RestController;
        import org.springframework.data.mongodb.repository.MongoRepository;

        @RestController
        public class UserController {
          @GetMapping("/users/{id}")
          public User get(String id) {
            String url = System.getenv("USER_DB_URL");
            return null;
          }

          @PostMapping("/users")
          public User create() { return null; }
        }
      `);

      const result = await parser.parseFile(path);

      const importSources = result.imports.map((i) => i.source);
      expect(importSources).toContain('org.springframework.web.bind.annotation.GetMapping');
      expect(importSources).toContain('org.springframework.data.mongodb.repository.MongoRepository');

      // Two Spring routes
      const routes = result.routes.filter((r) => r.framework.includes('springframework'));
      expect(routes.length).toBeGreaterThanOrEqual(2);
      const paths = routes.map((r) => r.path);
      expect(paths).toContain('/users/{id}');
      expect(paths).toContain('/users');

      // Mongo detected via prefix match
      expect(result.databaseUsages.some((d) => d.databaseType === 'MongoDB')).toBe(true);

      expect(result.envVars).toContain('USER_DB_URL');
    });
  });

  describe('Go extraction', () => {
    it('extracts gin routes + http client + env vars', async () => {
      const path = write('main.go', `
        package main

        import (
          "github.com/gin-gonic/gin"
          "github.com/lib/pq"
          "net/http"
          "os"
        )

        func main() {
          r := gin.Default()
          r.GET("/health", healthHandler)
          r.POST("/orders", createOrder)

          dbHost := os.Getenv("DB_HOST")
          http.Get("http://payments-service/api/v1/charge")
          _ = pq.NewListener
          _ = dbHost
        }
      `);

      const result = await parser.parseFile(path);

      expect(result.imports.map((i) => i.source)).toEqual(
        expect.arrayContaining(['github.com/gin-gonic/gin', 'github.com/lib/pq', 'net/http']),
      );

      const routePaths = result.routes.map((r) => r.path);
      expect(routePaths).toContain('/health');
      expect(routePaths).toContain('/orders');

      expect(result.databaseUsages.some((d) => d.databaseType === 'PostgreSQL')).toBe(true);
      expect(result.envVars).toContain('DB_HOST');
      expect(result.httpCalls.some((c) => c.url.includes('payments-service'))).toBe(true);
    });
  });

  describe('Python extraction', () => {
    it('extracts FastAPI routes + sqlalchemy + env', async () => {
      const path = write('app.py', `
        from fastapi import FastAPI
        from sqlalchemy import create_engine
        import os

        app = FastAPI()
        engine = create_engine(os.environ["DATABASE_URL"])

        @app.get("/items/{id}")
        async def read_item(id: int):
            return {"id": id}

        @app.post("/items")
        async def create_item():
            return {}
      `);

      const result = await parser.parseFile(path);

      expect(result.imports.map((i) => i.source)).toContain('fastapi');
      expect(result.imports.map((i) => i.source)).toContain('sqlalchemy');

      const routePaths = result.routes.map((r) => r.path);
      expect(routePaths).toContain('/items/{id}');
      expect(routePaths).toContain('/items');
      expect(result.envVars).toContain('DATABASE_URL');
      expect(result.databaseUsages.some((d) => d.databaseType === 'SQLAlchemy')).toBe(true);
    });
  });

  describe('Rust extraction', () => {
    it('extracts use + actix routes + env! macro', async () => {
      const path = write('main.rs', `
        use actix_web::{get, App};
        use sqlx::PgPool;

        #[get("/users/{id}")]
        async fn get_user() -> &'static str { "ok" }

        fn main() {
          let _ = std::env::var("APP_PORT");
          let _ = env!("BUILD_VERSION");
        }
      `);

      const result = await parser.parseFile(path);
      expect(result.imports.some((i) => i.source.startsWith('actix_web'))).toBe(true);
      expect(result.imports.some((i) => i.source.startsWith('sqlx'))).toBe(true);
      expect(result.routes.some((r) => r.path === '/users/{id}')).toBe(true);
      expect(result.envVars).toEqual(expect.arrayContaining(['APP_PORT', 'BUILD_VERSION']));
    });
  });
});
