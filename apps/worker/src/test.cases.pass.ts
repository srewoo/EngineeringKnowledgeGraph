/**
 * Test cases pass (Phase E).
 *
 * Lifts already-extracted File nodes + IMPORTS edges into a coverage graph:
 *   - A `TestCase` node per test file (id = `testcase:<fileId>`)
 *   - `(TestCase)-[:TESTS]->(File)` for every IMPORTS edge whose source is a
 *     test file and whose target is a non-test File in the same repo
 *
 * Why this works without a new parser: the only thing the agent needs to
 * answer "what tests cover X" is the link from the test file to the code
 * under test. We get that link for free from the existing import graph —
 * Vitest/Jest/Pytest/Go test files all import the modules they exercise.
 *
 * Out of scope for this slice (left to later passes):
 *   - One TestCase node per `it()` / `def test_*` block (requires parser
 *     extensions, not just relabelling)
 *   - Mock-aware filtering (skipping imports of `jest.fn`/`vi.mock`)
 *   - Test framework detection — currently inferred only from path patterns
 *
 * Pure / deterministic / no I/O. Idempotent — re-running yields the same
 * set of MERGE inputs.
 */

import { createLogger } from '@ekg/shared';
import type { GraphNode, GraphRelationship, Logger, TestCaseNode } from '@ekg/shared';

export interface TestCasesPassInput {
  readonly repoUrl: string;
  readonly nodes: readonly GraphNode[];
  readonly relationships: readonly GraphRelationship[];
}

export interface TestCasesPassResult {
  readonly newNodes: readonly TestCaseNode[];
  readonly newRelationships: readonly GraphRelationship[];
  readonly stats: Readonly<{
    testFilesDetected: number;
    testCasesEmitted: number;
    coversEdges: number;
    skippedNonRepoImports: number;
  }>;
}

const EMPTY: TestCasesPassResult = {
  newNodes: [],
  newRelationships: [],
  stats: { testFilesDetected: 0, testCasesEmitted: 0, coversEdges: 0, skippedNonRepoImports: 0 },
};

/**
 * Path-based test-file detector. Optimised for the common ecosystems —
 * conservative: a false negative just means "no coverage edges for this
 * test"; a false positive would emit phantom TestCase nodes pointing at
 * non-test code, so we err strict.
 */
export function isTestFilePath(path: string): boolean {
  if (!path) return false;
  const p = path.toLowerCase();
  // Anything inside node_modules is third-party — never our tests.
  if (p.includes('node_modules/')) return false;
  // Directory-based markers — typical layouts.
  if (/(^|\/)(__tests__|__test__|tests?|spec)\//.test(p)) {
    if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|rb|swift|cs)$/.test(p)) return true;
  }
  // Filename suffix conventions (all lower-cased patterns — `p` is already lower).
  if (/\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) return true;     // Vitest/Jest/Mocha
  if (/_test\.go$/.test(p)) return true;                                  // Go
  if (/(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(p)) return true;          // pytest
  // JUnit / xctest / .NET — `FooTest.java`, `FooTests.kt`, `FooTests.swift`.
  if (/test\.(java|kt|cs)$/.test(p) || /tests\.(java|kt|cs|swift)$/.test(p)) return true;
  if (/(^|\/)spec\//.test(p) && /\.rb$/.test(p)) return true;             // RSpec
  return false;
}

export class TestCasesPass {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'test-cases-pass' });
  }

  run(input: TestCasesPassInput): TestCasesPassResult {
    const fileById = new Map<string, GraphNode>();
    for (const n of input.nodes) {
      if (n.label === 'File') fileById.set(n.id, n);
    }
    if (fileById.size === 0) return EMPTY;

    // Index test files
    const testFileIds = new Set<string>();
    for (const [id, node] of fileById) {
      const path = (node.properties as { path?: string }).path ?? '';
      if (isTestFilePath(path)) testFileIds.add(id);
    }
    if (testFileIds.size === 0) return EMPTY;

    // Emit one TestCase per test file
    const newNodes: TestCaseNode[] = [];
    const testCaseByFileId = new Map<string, string>();
    for (const fileId of testFileIds) {
      const fileNode = fileById.get(fileId)!;
      const fileProps = fileNode.properties as { path?: string; language?: string };
      const tcId = `testcase:${fileId}`;
      testCaseByFileId.set(fileId, tcId);
      newNodes.push({
        id: tcId,
        label: 'TestCase',
        name: fileNode.name,
        properties: {
          repoUrl: input.repoUrl,
          testFile: fileProps.path ?? '',
          language: fileProps.language ?? 'unknown',
          framework: inferFramework(fileProps.path ?? '', fileProps.language ?? ''),
        },
      });
    }

    // Emit TESTS edges from each TestCase → File it imports (when target is
    // a File in the same repo and itself NOT a test file).
    const newRels: GraphRelationship[] = [];
    let skippedNonRepoImports = 0;
    for (const rel of input.relationships) {
      if (rel.type !== 'IMPORTS') continue;
      const tcId = testCaseByFileId.get(rel.sourceId);
      if (!tcId) continue;
      const target = fileById.get(rel.targetId);
      if (!target) {
        // IMPORTS can point at Module nodes (npm:* etc) — those aren't local code.
        skippedNonRepoImports += 1;
        continue;
      }
      if (testFileIds.has(rel.targetId)) continue; // tests testing tests = noise
      newRels.push({
        type: 'TESTS',
        sourceId: tcId,
        targetId: rel.targetId,
        confidence: 'MEDIUM', // inferred via imports, not actual call trace
        properties: { evidence: 'import' },
      });
    }

    this.logger.info({
      repoUrl: input.repoUrl,
      testFilesDetected: testFileIds.size,
      testCasesEmitted: newNodes.length,
      coversEdges: newRels.length,
      skippedNonRepoImports,
    }, 'test cases pass complete');

    return {
      newNodes,
      newRelationships: newRels,
      stats: {
        testFilesDetected: testFileIds.size,
        testCasesEmitted: newNodes.length,
        coversEdges: newRels.length,
        skippedNonRepoImports,
      },
    };
  }
}

/**
 * Heuristic framework detection by filename only. Cheap; agents can drill
 * deeper via search_codebase if they need the imported framework symbol.
 */
function inferFramework(path: string, language: string): string {
  const p = path.toLowerCase();
  if (/\.test\.(ts|tsx|js|jsx)$/.test(p) || /\.spec\.(ts|tsx|js|jsx)$/.test(p)) {
    if (p.includes('vitest')) return 'vitest';
    if (p.includes('cypress')) return 'cypress';
    if (p.includes('playwright')) return 'playwright';
    if (p.includes('jest')) return 'jest';
    // Default: TS/JS → unknown (could be any of the above)
    return 'jest-or-vitest';
  }
  if (/_test\.go$/.test(p)) return 'go-test';
  if (/\.py$/.test(p) && /(test_|_test)/.test(p)) return 'pytest';
  if (/Test\.java$/.test(p) || /Tests\.java$/.test(p)) return 'junit';
  if (/Spec\.kt$/.test(p) || /Test\.kt$/.test(p)) return 'junit-kotlin';
  if (/Tests\.swift$/.test(p)) return 'xctest';
  if (language === 'ruby') return 'rspec-or-minitest';
  return 'unknown';
}
