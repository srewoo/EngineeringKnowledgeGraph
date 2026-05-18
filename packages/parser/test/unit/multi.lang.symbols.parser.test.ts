import { describe, it, expect } from 'vitest';
import { MultiLangSymbolsParser } from '../../src/multi.lang.symbols.parser.js';

describe('MultiLangSymbolsParser - Python', () => {
  const parser = new MultiLangSymbolsParser();

  it('extracts top-level functions with async + docstring', () => {
    const src = [
      'def hello(name):',
      '    """Greet the user."""',
      '    return f"hi {name}"',
      '',
      'async def fetch(url, *, timeout=10):',
      '    pass',
      '',
      'def _private():',
      '    pass',
      '',
    ].join('\n');
    const r = parser.parse(src, 'app/util.py', 'python');
    expect(r.functions.map((f) => f.name).sort()).toEqual(['_private', 'fetch', 'hello']);
    const hello = r.functions.find((f) => f.name === 'hello')!;
    expect(hello.docComment).toBe('Greet the user.');
    expect(hello.isExported).toBe(true);
    const fetch = r.functions.find((f) => f.name === 'fetch')!;
    expect(fetch.isAsync).toBe(true);
    const priv = r.functions.find((f) => f.name === '_private')!;
    expect(priv.isExported).toBe(false);
  });

  it('attributes class methods to their class', () => {
    const src = [
      'class Repo:',
      '    """A repository."""',
      '    def __init__(self, name):',
      '        self.name = name',
      '    async def find(self, id):',
      '        return None',
      '    def _internal(self):',
      '        pass',
      '',
      'def standalone():',
      '    pass',
      '',
    ].join('\n');
    const r = parser.parse(src, 'a.py', 'python');
    expect(r.classes.map((c) => c.name)).toEqual(['Repo']);
    expect(r.methods.map((m) => m.name).sort()).toEqual(['__init__', '_internal', 'find']);
    expect(r.functions.map((f) => f.name)).toEqual(['standalone']);
    const find = r.methods.find((m) => m.name === 'find')!;
    expect(find.isAsync).toBe(true);
    expect(find.classId).toBe(r.classes[0]!.id);
    const internal = r.methods.find((m) => m.name === '_internal')!;
    expect(internal.visibility).toBe('protected');
  });
});

describe('MultiLangSymbolsParser - Go', () => {
  const parser = new MultiLangSymbolsParser();

  it('extracts package-level funcs and struct receiver methods', () => {
    const src = [
      'package svc',
      '',
      '// Greet says hi.',
      'func Greet(name string) string {',
      '    return "hi " + name',
      '}',
      '',
      'func helper() {}',
      '',
      'type User struct {',
      '    ID int',
      '}',
      '',
      'func (u *User) Save(ctx context.Context) error {',
      '    return nil',
      '}',
      '',
      'func (u User) String() string {',
      '    return ""',
      '}',
      '',
    ].join('\n');
    const r = parser.parse(src, 'svc/user.go', 'go');
    expect(r.functions.map((f) => f.name).sort()).toEqual(['Greet', 'helper']);
    const greet = r.functions.find((f) => f.name === 'Greet')!;
    expect(greet.isExported).toBe(true);
    expect(greet.docComment).toMatch(/Greet says hi/);
    const helper = r.functions.find((f) => f.name === 'helper')!;
    expect(helper.isExported).toBe(false);

    expect(r.classes.map((c) => c.name)).toEqual(['User']);
    expect(r.methods.map((m) => m.name).sort()).toEqual(['Save', 'String']);
    const save = r.methods.find((m) => m.name === 'Save')!;
    expect(save.classId).toBe(r.classes[0]!.id);
    expect(save.signature).toContain('Save(ctx context.Context)');
  });
});
