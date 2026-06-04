/**
 * Tree-sitter Python parser pilot (Phase A).
 *
 * We can't ship a hard runtime dep on `tree-sitter-python` in the default
 * install (per ADR-007), so the production code dynamic-imports it. These
 * tests exercise the **pure** parse-from-tree path with a hand-built
 * `TreeLike` fixture — no binary needed. This validates:
 *   - import / from-import detection
 *   - @app.<method>(...) route detection
 *   - DB SDK inference from imports
 *   - empty result on empty tree
 *
 * The dynamic-import / availability path is intentionally not unit-tested
 * here — it's an integration concern covered when `tree-sitter` is actually
 * installed in CI.
 */

import { describe, it, expect } from 'vitest';
import { parseFromTree as parsePythonFromTree, type SyntaxNodeLike, type TreeLike } from '../../src/tree-sitter/python.parser.js';

// ---- tiny fixture builder ----

let _id = 0;
function n(type: string, text: string, children: SyntaxNodeLike[] = [], row = 0): SyntaxNodeLike {
  _id += 1;
  return {
    type,
    text,
    startPosition: { row, column: 0 },
    endPosition: { row, column: text.length },
    children,
  };
}

function tree(root: SyntaxNodeLike): TreeLike { return { rootNode: root }; }

describe('parsePythonFromTree — imports', () => {
  it('extracts `import x` as a HIGH-confidence import', () => {
    // import_statement → dotted_name 'requests'
    const t = tree(
      n('module', 'import requests', [
        n('import_statement', 'import requests', [
          n('dotted_name', 'requests'),
        ], 0),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'x.py', content: 'import requests\n', tree: t });
    expect(out.imports).toHaveLength(1);
    expect(out.imports[0]!.source).toBe('requests');
    expect(out.imports[0]!.isLocal).toBe(false);
  });

  it('extracts `from x.y import z` keeping the dotted module name', () => {
    const t = tree(
      n('module', '', [
        n('import_from_statement', 'from fastapi import APIRouter', [
          n('dotted_name', 'fastapi'),
          n('dotted_name', 'APIRouter'),
        ], 3),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'x.py', content: '\n\n\nfrom fastapi import APIRouter\n', tree: t });
    expect(out.imports).toHaveLength(1);
    expect(out.imports[0]!.source).toBe('fastapi');
  });

  it('returns no imports for empty module', () => {
    const t = tree(n('module', '', []));
    const out = parsePythonFromTree({ filePath: 'x.py', content: '', tree: t });
    expect(out.imports).toHaveLength(0);
    expect(out.loc).toBe(0);
  });
});

describe('parsePythonFromTree — routes', () => {
  it('detects @app.get("/v1/things") as a route', () => {
    // decorator → call → attribute(app.get) → argument_list("/v1/things")
    const t = tree(
      n('module', '', [
        n('decorator', '@app.get("/v1/things")', [
          n('call', 'app.get("/v1/things")', [
            n('attribute', 'app.get', [
              n('identifier', 'app'),
              n('identifier', 'get'),
            ]),
            n('argument_list', '("/v1/things")', [
              n('string', '"/v1/things"'),
            ]),
          ]),
        ], 5),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'r.py', content: '\n\n\n\n\n@app.get("/v1/things")\n', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('GET');
    expect(out.routes[0]!.path).toBe('/v1/things');
    expect(out.routes[0]!.framework).toBe('python-decorator');
  });

  it('skips decorators that are not HTTP methods', () => {
    const t = tree(
      n('module', '', [
        n('decorator', '@logger.info("...")', [
          n('call', 'logger.info("...")', [
            n('attribute', 'logger.info', [
              n('identifier', 'logger'),
              n('identifier', 'info'),
            ]),
            n('argument_list', '("...")', [n('string', '"..."')]),
          ]),
        ]),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'r.py', content: '@logger.info("...")\n', tree: t });
    expect(out.routes).toHaveLength(0);
  });
});

describe('parsePythonFromTree — db SDKs', () => {
  it('infers PostgreSQL usage from `import psycopg`', () => {
    const t = tree(
      n('module', '', [
        n('import_statement', 'import psycopg', [n('dotted_name', 'psycopg')]),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'd.py', content: 'import psycopg\n', tree: t });
    expect(out.databaseUsages).toHaveLength(1);
    expect(out.databaseUsages[0]!.databaseType).toBe('PostgreSQL');
    expect(out.databaseUsages[0]!.packageName).toBe('psycopg');
  });

  it('infers SQL usage from `import sqlalchemy.orm`', () => {
    const t = tree(
      n('module', '', [
        n('import_statement', 'import sqlalchemy.orm', [n('dotted_name', 'sqlalchemy.orm')]),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'd.py', content: '', tree: t });
    expect(out.databaseUsages[0]?.databaseType).toBe('SQL');
  });

  it('does not infer DB usage for unrelated imports', () => {
    const t = tree(
      n('module', '', [
        n('import_statement', 'import json', [n('dotted_name', 'json')]),
      ])
    );
    const out = parsePythonFromTree({ filePath: 'd.py', content: 'import json\n', tree: t });
    expect(out.databaseUsages).toHaveLength(0);
  });
});
