import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileScanner } from '../../src/file.scanner.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FileScanner', () => {
  let scanner: FileScanner;
  let dir: string;

  beforeEach(() => {
    scanner = new FileScanner();
    dir = mkdtempSync(join(tmpdir(), 'ekg-fs-test-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function w(name: string, content = 'x'): void {
    const sub = join(dir, ...name.split('/').slice(0, -1));
    if (sub !== dir) mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, name), content);
  }

  it('returns source files and skips binaries / lockfiles / large files', async () => {
    w('src/index.ts', 'export {};');
    w('src/util.go', 'package x');
    w('src/lib.jar', 'JAR-DATA');
    w('package-lock.json', '{}');
    w('build/output.min.js', 'console.log(1)');
    w('docs/diagram.svg', '<svg/>');
    w('node_modules/lib/index.js', '// noise');
    // Large file
    const big = 'a'.repeat(3 * 1024 * 1024);
    w('src/bundle.json', big);

    const files = await scanner.scan(dir);
    const rels = files.map((f) => f.relativePath).sort();
    expect(rels).toContain('src/index.ts');
    expect(rels).toContain('src/util.go');
    expect(rels).not.toContain('src/lib.jar');
    expect(rels).not.toContain('package-lock.json');
    expect(rels).not.toContain('build/output.min.js');
    expect(rels).not.toContain('docs/diagram.svg');
    expect(rels.find((r) => r.includes('node_modules'))).toBeUndefined();
    expect(rels).not.toContain('src/bundle.json');
  });
});
