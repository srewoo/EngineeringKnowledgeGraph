/**
 * Tree-sitter Java pure-parse tests.
 */

import { describe, it, expect } from 'vitest';
import { parseJavaFromTree } from '../../src/index.js';
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

describe('parseJavaFromTree — imports', () => {
  it('extracts a fully-qualified import', () => {
    const t = tree(
      n('program', '', [
        n('import_declaration', 'import com.example.Foo;', [
          n('scoped_identifier', 'com.example.Foo'),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'F.java', content: '', tree: t });
    expect(out.imports).toHaveLength(1);
    expect(out.imports[0]!.source).toBe('com.example.Foo');
    expect(out.imports[0]!.isTypeOnly).toBe(false);
  });

  it('flags `import static` via isTypeOnly', () => {
    const t = tree(
      n('program', '', [
        n('import_declaration', 'import static org.junit.Assert.*;', [
          n('static', 'static'),
          n('scoped_identifier', 'org.junit.Assert.*'),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'F.java', content: '', tree: t });
    expect(out.imports[0]!.isTypeOnly).toBe(true);
  });
});

describe('parseJavaFromTree — Spring routes', () => {
  it('detects @GetMapping("/path")', () => {
    const t = tree(
      n('program', '', [
        n('annotation', '@GetMapping("/users")', [
          n('identifier', 'GetMapping'),
          n('annotation_argument_list', '("/users")', [
            n('string_literal', '"/users"'),
          ]),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'R.java', content: '', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('GET');
    expect(out.routes[0]!.path).toBe('/users');
    expect(out.routes[0]!.framework).toBe('spring');
  });

  it('detects @RequestMapping(value="/x", method=RequestMethod.POST)', () => {
    const t = tree(
      n('program', '', [
        n('annotation', '@RequestMapping(value = "/x", method = RequestMethod.POST)', [
          n('identifier', 'RequestMapping'),
          n('annotation_argument_list', '', [
            n('element_value_pair', 'value = "/x"', [
              n('identifier', 'value'),
              n('string_literal', '"/x"'),
            ]),
            n('element_value_pair', 'method = RequestMethod.POST', [
              n('identifier', 'method'),
              n('field_access', 'RequestMethod.POST', [
                n('identifier', 'RequestMethod'),
                n('identifier', 'POST'),
              ]),
            ]),
          ]),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'R.java', content: '', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('POST');
    expect(out.routes[0]!.path).toBe('/x');
  });

  it('falls back to ANY method when @RequestMapping has no method=', () => {
    const t = tree(
      n('program', '', [
        n('annotation', '@RequestMapping("/x")', [
          n('identifier', 'RequestMapping'),
          n('annotation_argument_list', '("/x")', [n('string_literal', '"/x"')]),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'R.java', content: '', tree: t });
    expect(out.routes[0]!.method).toBe('ANY');
  });
});

describe('parseJavaFromTree — JAX-RS routes', () => {
  it('detects @Path("/users") class annotation', () => {
    const t = tree(
      n('program', '', [
        n('annotation', '@Path("/users")', [
          n('identifier', 'Path'),
          n('annotation_argument_list', '("/users")', [n('string_literal', '"/users"')]),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'R.java', content: '', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('ANY');
    expect(out.routes[0]!.path).toBe('/users');
    expect(out.routes[0]!.framework).toBe('jaxrs');
  });

  it('detects @GET method-level marker as method-only route', () => {
    const t = tree(
      n('program', '', [
        n('marker_annotation', '@GET', [
          n('identifier', 'GET'),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'R.java', content: '', tree: t });
    expect(out.routes).toHaveLength(1);
    expect(out.routes[0]!.method).toBe('GET');
    expect(out.routes[0]!.path).toBe('');
  });
});

describe('parseJavaFromTree — DB SDKs', () => {
  it('infers SQL from org.springframework.data.jpa import', () => {
    const t = tree(
      n('program', '', [
        n('import_declaration', '', [
          n('scoped_identifier', 'org.springframework.data.jpa.repository.JpaRepository'),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'D.java', content: '', tree: t });
    expect(out.databaseUsages).toHaveLength(1);
    expect(out.databaseUsages[0]!.databaseType).toBe('SQL');
    expect(out.databaseUsages[0]!.packageName).toBe('spring-data-jpa');
  });

  it('infers Redis from redis.clients.jedis', () => {
    const t = tree(
      n('program', '', [
        n('import_declaration', '', [
          n('scoped_identifier', 'redis.clients.jedis.Jedis'),
        ]),
      ])
    );
    const out = parseJavaFromTree({ filePath: 'D.java', content: '', tree: t });
    expect(out.databaseUsages[0]?.databaseType).toBe('Redis');
  });
});
