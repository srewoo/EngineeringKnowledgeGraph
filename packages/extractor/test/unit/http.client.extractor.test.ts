import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { HttpClientTypeScriptExtractor } from '@ekg/parser';
import type { ParsedImport } from '@ekg/shared';

function parse(src: string, importedFrom = 'axios') {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('test.ts', src);
  const imports: ParsedImport[] = [
    { source: importedFrom, specifiers: [importedFrom], isTypeOnly: false, isLocal: false },
  ];
  return { sf, imports };
}

describe('HttpClientTypeScriptExtractor', () => {
  const extractor = new HttpClientTypeScriptExtractor();

  it('captures axios.get with literal URL', () => {
    const { sf, imports } = parse(`
      import axios from 'axios';
      export async function fetchUser(id: string) {
        return axios.get('https://users.api.example.com/api/v1/users/42');
      }
    `);
    const out = extractor.extract(sf, imports, 'fileX');
    expect(out.length).toBe(1);
    expect(out[0]?.method).toBe('GET');
    expect(out[0]?.url).toBe('https://users.api.example.com/api/v1/users/42');
    expect(out[0]?.callerSymbolId).toBeDefined();
    expect(out[0]?.callerSymbolId).toContain('fn:fileX:fetchUser');
  });

  it('captures fetch with template URL and preserves placeholder', () => {
    const { sf, imports } = parse(`
      import 'node-fetch';
      const baseUrl = 'https://x';
      const id = '1';
      const r = fetch(\`\${baseUrl}/api/v1/users/\${id}\`);
    `, 'node-fetch');
    const out = extractor.extract(sf, imports, 'f');
    expect(out.length).toBe(1);
    expect(out[0]?.isTemplate).toBe(true);
    expect(out[0]?.url).toBe('{var}/api/v1/users/{var}');
  });

  it('captures got.post with object literal URL', () => {
    const { sf, imports } = parse(`
      import got from 'got';
      class Svc {
        async push() {
          return got.post('https://billing/api/v1/charge', { json: {} });
        }
      }
    `, 'got');
    const out = extractor.extract(sf, imports, 'fX');
    expect(out.length).toBe(1);
    expect(out[0]?.method).toBe('POST');
    expect(out[0]?.callerSymbolId).toContain('method:cls:fX:Svc:');
    expect(out[0]?.callerSymbolId).toContain(':push:');
  });

  it('skips calls without HTTP-like URLs', () => {
    const { sf, imports } = parse(`
      import axios from 'axios';
      const x = axios.get('not-a-url');
    `);
    const out = extractor.extract(sf, imports, 'f');
    expect(out.length).toBe(0);
  });
});
