import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerCodeGrepTool } from '../../src/tools/code-grep.tool.js';

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ekg-code-grep-'));
  const reposRoot = join(dataDir, 'repos');
  mkdirSync(reposRoot);

  const um = join(reposRoot, 'user-management');
  mkdirSync(join(um, 'internal'), { recursive: true });
  writeFileSync(
    join(um, 'internal', 'users.go'),
    `package internal\n\nfunc Save() error {\n  _, err := db.Exec("INSERT IGNORE INTO users(id) VALUES(?)", id)\n  return err\n}\n`,
  );
  writeFileSync(
    join(um, 'README.md'),
    'No SQL here.\n',
  );

  const es = join(reposRoot, 'entity-service');
  mkdirSync(es, { recursive: true });
  writeFileSync(
    join(es, 'main.go'),
    `package main\n\n// INSERT IGNORE comment\nfunc main() {\n  query := "insert ignore into entities values (?)"\n  _ = query\n}\n`,
  );
  writeFileSync(
    join(es, 'helper.ts'),
    `export const q = "INSERT IGNORE INTO logs VALUES (?)"\n`,
  );
});

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

async function callTool(args: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerCodeGrepTool(server, { dataDir });
  // The MCP SDK exposes registered tools; reach into the underlying handler.
  const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })._registeredTools['code_grep'];
  if (!reg) throw new Error('code_grep not registered');
  const res = (await reg.handler(args)) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0]!.text, ...(res.isError ? { isError: true } : {}) };
}

describe('code_grep tool', () => {
  it('finds INSERT IGNORE in Go files only when languages=[go]', async () => {
    const out = await callTool({
      pattern: 'INSERT\\s+IGNORE',
      literal: false,
      caseInsensitive: true,
      languages: ['go'],
      maxResults: 50,
    });
    const parsed = JSON.parse(out.text);
    expect(parsed.matchCount).toBeGreaterThanOrEqual(2);
    const repos = new Set(parsed.matches.map((m: { repo: string }) => m.repo));
    expect(repos.has('user-management')).toBe(true);
    expect(repos.has('entity-service')).toBe(true);
    // No .ts hits
    const tsHits = parsed.matches.filter((m: { file: string }) => m.file.endsWith('.ts'));
    expect(tsHits).toHaveLength(0);
  });

  it('respects repos filter', async () => {
    const out = await callTool({
      pattern: 'INSERT IGNORE',
      literal: true,
      caseInsensitive: true,
      repos: ['entity-service'],
      languages: ['go'],
      maxResults: 50,
    });
    const parsed = JSON.parse(out.text);
    const repos = new Set(parsed.matches.map((m: { repo: string }) => m.repo));
    expect(repos.has('entity-service')).toBe(true);
    expect(repos.has('user-management')).toBe(false);
  });

  it('returns isError when pattern is invalid regex and not literal', async () => {
    const out = await callTool({
      pattern: '(',
      literal: false,
      caseInsensitive: false,
      maxResults: 10,
    });
    expect(out.isError).toBe(true);
  });

  it('errors when DATA_DIR/repos does not exist', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerCodeGrepTool(server, { dataDir: '/nonexistent-ekg-dir-xyz' });
    const reg = (server as unknown as { _registeredTools: Record<string, { handler: (a: unknown) => Promise<unknown> }> })._registeredTools['code_grep']!;
    const res = (await reg.handler({
      pattern: 'foo',
      literal: false,
      caseInsensitive: false,
      maxResults: 10,
    })) as { isError?: boolean };
    expect(res.isError).toBe(true);
  });
});
