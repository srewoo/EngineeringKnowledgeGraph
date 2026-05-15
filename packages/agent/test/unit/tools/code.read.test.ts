import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCodeReadTool, resolveSafe } from '../../../src/tools/code.read.tool.js';

let root: string;
let repoDir: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ekg-coderead-'));
  repoDir = path.join(root, 'demo-repo');
  await fs.mkdir(repoDir, { recursive: true });
  const lines = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n');
  await fs.writeFile(path.join(repoDir, 'big.txt'), lines, 'utf8');
  await fs.writeFile(path.join(root, 'outside.txt'), 'secret', 'utf8');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveSafe', () => {
  it('rejects ../ traversal', () => {
    expect(() => resolveSafe('../outside.txt', root + '/demo-repo')).toThrow(/refused/);
  });
  it('rejects absolute path outside root', () => {
    expect(() => resolveSafe('/etc/passwd', root)).toThrow(/refused/);
  });
  it('accepts repo-relative path', () => {
    const out = resolveSafe('demo-repo/big.txt', root);
    expect(out).toBe(path.join(root, 'demo-repo', 'big.txt'));
  });
});

describe('buildCodeReadTool', () => {
  it('refuses path traversal via tool', async () => {
    const tool = buildCodeReadTool({ reposRoot: repoDir });
    await expect(tool.invoke({ path: '../outside.txt' })).rejects.toThrow(/refused/);
  });

  it('caps line range at MAX_LINES', async () => {
    const tool = buildCodeReadTool({ reposRoot: root });
    const res = await tool.invoke({ path: 'demo-repo/big.txt', lineStart: 1, lineEnd: 500 });
    // Should include line 1 and line 200 but not line 201.
    expect(res.text).toContain('1: line 1');
    expect(res.text).toContain('200: line 200');
    expect(res.text).not.toContain('\n201: line 201');
    expect(res.text).toMatch(/lines 1-200, truncated/);
  });

  it('honours explicit small range', async () => {
    const tool = buildCodeReadTool({ reposRoot: root });
    const res = await tool.invoke({ path: 'demo-repo/big.txt', lineStart: 10, lineEnd: 12 });
    expect(res.text).toContain('10: line 10');
    expect(res.text).toContain('12: line 12');
    expect(res.text).not.toContain('13: line 13');
  });
});
