import { describe, it, expect } from 'vitest';
import { MetadataScanner } from '../../src/metadata.scanner.js';

describe('MetadataScanner.resolveOwners', () => {
  it('matches glob and dir prefix patterns; later rule wins', () => {
    const rules = [
      { pattern: '*', owners: ['@core/maintainers'] },
      { pattern: '/apps/web/', owners: ['@frontend/team', '@alice'] },
      { pattern: '*.ts', owners: ['@ts-lords'] },
    ];

    expect(MetadataScanner.resolveOwners('apps/web/src/page.tsx', rules))
      .toEqual(['@frontend/team', '@alice']);
    // *.ts rule comes later — wins for top-level .ts file
    expect(MetadataScanner.resolveOwners('vite.config.ts', rules))
      .toEqual(['@ts-lords']);
    // No specific rule for python file → falls back to *
    expect(MetadataScanner.resolveOwners('scripts/build.py', rules))
      .toEqual(['@core/maintainers']);
  });

  it('returns [] when no rule matches', () => {
    const rules = [{ pattern: '/apps/web/', owners: ['@x'] }];
    expect(MetadataScanner.resolveOwners('docs/README.md', rules)).toEqual([]);
  });
});
