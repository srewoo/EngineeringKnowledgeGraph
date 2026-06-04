/**
 * Pure-derivation tests for TestCasesPass — no Neo4j, no I/O. Validates that:
 *   - test files are detected by path patterns across ecosystems
 *   - one TestCase node is emitted per detected test file
 *   - IMPORTS edges from test files become TESTS edges on the TestCase
 *   - non-File targets (Module / npm imports) are skipped
 *   - test→test imports don't emit phantom TESTS edges
 */

import { describe, it, expect } from 'vitest';
import { TestCasesPass, isTestFilePath } from '../../src/test.cases.pass.js';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

const REPO = 'https://gitlab.example.com/foo/bar';

function file(path: string, language = 'typescript'): GraphNode {
  return {
    id: `${REPO}:${path}`,
    label: 'File',
    name: path.split('/').pop() ?? path,
    properties: { path, language },
  };
}

function mod(name: string): GraphNode {
  return {
    id: `npm:${name}`,
    label: 'Module',
    name,
    properties: { name },
  };
}

function importEdge(from: string, to: string): GraphRelationship {
  return { type: 'IMPORTS', sourceId: from, targetId: to, confidence: 'HIGH', properties: {} };
}

describe('isTestFilePath', () => {
  it('detects Vitest/Jest suffix patterns', () => {
    expect(isTestFilePath('src/utils.test.ts')).toBe(true);
    expect(isTestFilePath('src/utils.spec.tsx')).toBe(true);
    expect(isTestFilePath('lib/foo.test.js')).toBe(true);
  });
  it('detects Go _test.go pattern', () => {
    expect(isTestFilePath('pkg/foo_test.go')).toBe(true);
  });
  it('detects pytest patterns', () => {
    expect(isTestFilePath('tests/test_user.py')).toBe(true);
    expect(isTestFilePath('app/foo_test.py')).toBe(true);
  });
  it('detects JUnit / xctest patterns', () => {
    expect(isTestFilePath('src/UserTest.java')).toBe(true);
    expect(isTestFilePath('ios/AppTests.swift')).toBe(true);
  });
  it('detects directory-based test layouts', () => {
    expect(isTestFilePath('__tests__/whatever.ts')).toBe(true);
    expect(isTestFilePath('packages/foo/test/unit/bar.test.ts')).toBe(true);
  });
  it('rejects regular source files', () => {
    expect(isTestFilePath('src/index.ts')).toBe(false);
    expect(isTestFilePath('lib/foo.go')).toBe(false);
    expect(isTestFilePath('app/views/test.html')).toBe(false);
  });
  it('rejects node_modules paths', () => {
    expect(isTestFilePath('node_modules/some-pkg/tests/foo.test.ts')).toBe(false);
  });
  it('handles empty / undefined paths', () => {
    expect(isTestFilePath('')).toBe(false);
  });
});

describe('TestCasesPass.run', () => {
  it('returns empty when there are no test files', () => {
    const pass = new TestCasesPass();
    const result = pass.run({
      repoUrl: REPO,
      nodes: [file('src/index.ts'), file('lib/foo.ts')],
      relationships: [importEdge(`${REPO}:src/index.ts`, `${REPO}:lib/foo.ts`)],
    });
    expect(result.newNodes).toHaveLength(0);
    expect(result.newRelationships).toHaveLength(0);
  });

  it('emits one TestCase per test file', () => {
    const pass = new TestCasesPass();
    const result = pass.run({
      repoUrl: REPO,
      nodes: [file('src/foo.test.ts'), file('lib/bar.spec.ts'), file('src/index.ts')],
      relationships: [],
    });
    expect(result.newNodes).toHaveLength(2);
    expect(result.newNodes.every((n) => n.label === 'TestCase')).toBe(true);
    const ids = result.newNodes.map((n) => n.id);
    expect(ids).toContain(`testcase:${REPO}:src/foo.test.ts`);
    expect(ids).toContain(`testcase:${REPO}:lib/bar.spec.ts`);
  });

  it('emits TESTS edges from TestCase to imported repo files', () => {
    const pass = new TestCasesPass();
    const testFile = file('src/foo.test.ts');
    const srcFile = file('src/foo.ts');
    const result = pass.run({
      repoUrl: REPO,
      nodes: [testFile, srcFile],
      relationships: [importEdge(testFile.id, srcFile.id)],
    });
    expect(result.newRelationships).toHaveLength(1);
    const edge = result.newRelationships[0]!;
    expect(edge.type).toBe('TESTS');
    expect(edge.sourceId).toBe(`testcase:${testFile.id}`);
    expect(edge.targetId).toBe(srcFile.id);
    expect(edge.confidence).toBe('MEDIUM');
    expect(edge.properties).toEqual({ evidence: 'import' });
  });

  it('skips imports of non-File nodes (modules)', () => {
    const pass = new TestCasesPass();
    const testFile = file('src/foo.test.ts');
    const npmMod = mod('vitest');
    const result = pass.run({
      repoUrl: REPO,
      nodes: [testFile, npmMod],
      relationships: [importEdge(testFile.id, npmMod.id)],
    });
    expect(result.newRelationships).toHaveLength(0);
    expect(result.stats.skippedNonRepoImports).toBe(1);
  });

  it('does not emit TESTS edges between two test files', () => {
    const pass = new TestCasesPass();
    const t1 = file('src/a.test.ts');
    const t2 = file('src/helpers.test.ts');
    const result = pass.run({
      repoUrl: REPO,
      nodes: [t1, t2],
      relationships: [importEdge(t1.id, t2.id)],
    });
    expect(result.newRelationships).toHaveLength(0);
  });
});
