import { describe, it, expect } from 'vitest';
import { CodeownersExtractor } from '../../src/codeowners.extractor.js';
import type { CodeOwnerRule } from '@ekg/parser';

const REPO = 'https://example.com/org/repo';

function fileFixture(paths: string[]): { fileId: string; relativePath: string }[] {
  return paths.map((p) => ({ fileId: `${REPO}:${p}`, relativePath: p }));
}

describe('CodeownersExtractor', () => {
  const extractor = new CodeownersExtractor();

  it('returns nothing when no rules or no files', () => {
    const r1 = extractor.extract({ rules: [], repoUrl: REPO, repoFiles: fileFixture(['a.ts']) });
    expect(r1.relationships).toHaveLength(0);
    const r2 = extractor.extract({ rules: [{ pattern: '*', owners: ['@u'] }], repoUrl: REPO, repoFiles: [] });
    expect(r2.relationships).toHaveLength(0);
  });

  it('emits Owner node + OWNED_BY for a simple `* @user` rule', () => {
    const rules: CodeOwnerRule[] = [{ pattern: '*', owners: ['@octocat'] }];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['src/a.ts', 'src/b.ts']),
    });
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0]?.id).toBe('owner:octocat');
    expect(result.owners[0]?.properties.kind).toBe('user');
    expect(result.owners[0]?.properties.identifier).toBe('@octocat');
    expect(result.relationships).toHaveLength(2);
    expect(result.relationships[0]?.type).toBe('OWNED_BY');
  });

  it('emits Team node for `@org/team` handles', () => {
    const rules: CodeOwnerRule[] = [{ pattern: 'apps/web/', owners: ['@acme/web-platform'] }];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['apps/web/page.ts', 'apps/api/x.ts']),
    });
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]?.id).toBe('team:acme/web-platform');
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]?.targetId).toBe('team:acme/web-platform');
  });

  it('classifies plain emails as kind=email', () => {
    const rules: CodeOwnerRule[] = [{ pattern: '*', owners: ['ops@example.com'] }];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['x.ts']),
    });
    expect(result.owners).toHaveLength(1);
    expect(result.owners[0]?.properties.kind).toBe('email');
    expect(result.owners[0]?.id).toBe('owner:ops@example.com');
  });

  it('last matching rule wins (CODEOWNERS spec)', () => {
    const rules: CodeOwnerRule[] = [
      { pattern: '*', owners: ['@everyone'] },
      { pattern: 'apps/web/', owners: ['@web-team'] },
    ];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['apps/web/page.ts', 'README.md']),
    });
    const webEdges = result.relationships.filter((r) => r.sourceId.endsWith('apps/web/page.ts'));
    expect(webEdges).toHaveLength(1);
    expect(webEdges[0]?.targetId).toBe('owner:web-team');
    const readmeEdges = result.relationships.filter((r) => r.sourceId.endsWith('README.md'));
    expect(readmeEdges).toHaveLength(1);
    expect(readmeEdges[0]?.targetId).toBe('owner:everyone');
  });

  it('supports multiple owners per rule', () => {
    const rules: CodeOwnerRule[] = [
      { pattern: '*', owners: ['@a', '@b', '@org/c'] },
    ];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['x.ts']),
    });
    expect(result.relationships).toHaveLength(3);
    expect(result.owners.map((o) => o.id).sort()).toEqual(['owner:a', 'owner:b']);
    expect(result.teams.map((t) => t.id)).toEqual(['team:org/c']);
  });

  it('matches `**/path/*.ts` style globs', () => {
    const rules: CodeOwnerRule[] = [{ pattern: '**/internal/*.ts', owners: ['@security'] }];
    const result = extractor.extract({
      rules,
      repoUrl: REPO,
      repoFiles: fileFixture(['apps/web/internal/secret.ts', 'apps/web/public/page.ts']),
    });
    expect(result.relationships).toHaveLength(1);
    expect(result.relationships[0]?.sourceId.endsWith('internal/secret.ts')).toBe(true);
  });
});
