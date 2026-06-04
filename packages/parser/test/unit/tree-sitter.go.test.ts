/**
 * Tree-sitter Go pure-parse tests. Same fixture pattern as the Python
 * pilot — hand-built TreeLike, no native binding needed.
 */

import { describe, it, expect } from 'vitest';
import { parseGoFromTree } from '../../src/index.js';
import type { SyntaxNodeLike, TreeLike } from '../../src/tree-sitter/python.parser.js';

function n(type: string, text: string, children: SyntaxNodeLike[] = [], row = 0): SyntaxNodeLike {
  return {
    type, text,
    startPosition: { row, column: 0 },
    endPosition: { row, column: text.length },
    children,
  };
}
function tree(root: SyntaxNodeLike): TreeLike { return { rootNode: root }; }

describe('parseGoFromTree — imports', () => {
  it('extracts single-line imports', () => {
    const t = tree(
      n('source_file', '', [
        n('import_declaration', 'import "fmt"', [
          n('import_spec', '"fmt"', [
            n('interpreted_string_literal', '"fmt"'),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'a.go', content: 'import "fmt"\n', tree: t });
    expect(out.imports).toHaveLength(1);
    expect(out.imports[0]!.source).toBe('fmt');
    expect(out.imports[0]!.isLocal).toBe(true); // no slash → stdlib / local
  });

  it('extracts multi-line `import (...)` blocks', () => {
    const t = tree(
      n('source_file', '', [
        n('import_declaration', 'import (\n"fmt"\n"github.com/lib/pq"\n)', [
          n('import_spec_list', '', [
            n('import_spec', '"fmt"', [n('interpreted_string_literal', '"fmt"')]),
            n('import_spec', '"github.com/lib/pq"', [n('interpreted_string_literal', '"github.com/lib/pq"')]),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'a.go', content: '', tree: t });
    expect(out.imports.map((i) => i.source)).toEqual(['fmt', 'github.com/lib/pq']);
  });
});

describe('parseGoFromTree — routes', () => {
  it('detects gin-style r.GET("/path", handler)', () => {
    // call_expression
    //   selector_expression r.GET
    //   argument_list ("/v1/things", h)
    const t = tree(
      n('source_file', '', [
        n('call_expression', 'r.GET("/v1/things", h)', [
          n('selector_expression', 'r.GET', [
            n('identifier', 'r'),
            n('field_identifier', 'GET'),
          ]),
          n('argument_list', '("/v1/things", h)', [
            n('interpreted_string_literal', '"/v1/things"'),
            n('identifier', 'h'),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'r.go', content: '', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('GET');
    expect(out.routes[0]!.path).toBe('/v1/things');
    expect(out.routes[0]!.framework).toBe('go-router');
  });

  it('treats http.HandleFunc as method=ANY', () => {
    const t = tree(
      n('source_file', '', [
        n('call_expression', 'http.HandleFunc("/x", h)', [
          n('selector_expression', 'http.HandleFunc', [
            n('identifier', 'http'),
            n('field_identifier', 'HandleFunc'),
          ]),
          n('argument_list', '("/x", h)', [
            n('interpreted_string_literal', '"/x"'),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'r.go', content: '', tree: t });
    expect(out.routes[0]!.method).toBe('ANY');
    expect(out.routes[0]!.path).toBe('/x');
  });

  it('skips selector_expressions that aren\'t HTTP methods', () => {
    const t = tree(
      n('source_file', '', [
        n('call_expression', 'log.Info("hi")', [
          n('selector_expression', 'log.Info', [
            n('identifier', 'log'),
            n('field_identifier', 'Info'),
          ]),
          n('argument_list', '("hi")', [n('interpreted_string_literal', '"hi"')]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'r.go', content: '', tree: t });
    expect(out.routes).toHaveLength(0);
  });
});

describe('parseGoFromTree — DB SDKs', () => {
  it('infers PostgreSQL from github.com/lib/pq import', () => {
    const t = tree(
      n('source_file', '', [
        n('import_declaration', '', [
          n('import_spec', '"github.com/lib/pq"', [
            n('interpreted_string_literal', '"github.com/lib/pq"'),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'd.go', content: '', tree: t });
    expect(out.databaseUsages).toHaveLength(1);
    expect(out.databaseUsages[0]!.databaseType).toBe('PostgreSQL');
    expect(out.databaseUsages[0]!.packageName).toBe('pq');
  });

  it('infers SQL via gorm.io/gorm', () => {
    const t = tree(
      n('source_file', '', [
        n('import_declaration', '', [
          n('import_spec', '"gorm.io/gorm"', [
            n('interpreted_string_literal', '"gorm.io/gorm"'),
          ]),
        ]),
      ])
    );
    const out = parseGoFromTree({ filePath: 'd.go', content: '', tree: t });
    expect(out.databaseUsages[0]?.databaseType).toBe('SQL');
    expect(out.databaseUsages[0]?.packageName).toBe('gorm');
  });
});
