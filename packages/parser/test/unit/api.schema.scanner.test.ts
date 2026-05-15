import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApiSchemaScanner } from '../../src/api.schema.scanner.js';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ApiSchemaScanner', () => {
  let tempDir: string;
  let scanner: ApiSchemaScanner;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ekg-schema-test-'));
    scanner = new ApiSchemaScanner();
  });
  afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

  function write(name: string, content: string): void {
    const dir = join(tempDir, ...name.split('/').slice(0, -1));
    if (dir !== tempDir) mkdirSync(dir, { recursive: true });
    writeFileSync(join(tempDir, name), content, 'utf-8');
  }

  it('extracts paths from a YAML OpenAPI spec', async () => {
    write('openapi.yaml', `
openapi: 3.0.0
info:
  title: User API
paths:
  /users:
    get:
      summary: List users
    post:
      summary: Create
  /users/{id}:
    get:
      summary: Get
    delete:
      summary: Delete
`);

    const results = await scanner.scan(tempDir);
    const all = results.flatMap((r) => r.routes);
    const paths = all.map((r) => `${r.method} ${r.path}`);
    expect(paths).toEqual(expect.arrayContaining([
      'GET /users', 'POST /users', 'GET /users/{id}', 'DELETE /users/{id}',
    ]));
  });

  it('extracts rpcs from a .proto file', async () => {
    write('greeter.proto', `
      syntax = "proto3";
      service Greeter {
        rpc SayHello (HelloReq) returns (HelloResp);
        rpc SayBye (Req) returns (Resp);
      }
    `);
    const results = await scanner.scan(tempDir);
    const rpcs = results.flatMap((r) => r.routes);
    expect(rpcs.map((r) => r.path)).toEqual(expect.arrayContaining([
      '/Greeter/SayHello', '/Greeter/SayBye',
    ]));
    expect(rpcs.every((r) => r.method === 'GRPC')).toBe(true);
  });

  it('extracts query/mutation fields from a GraphQL schema', async () => {
    write('schema.graphql', `
      type Query {
        user(id: ID!): User
        users: [User!]!
      }
      type Mutation {
        createUser(input: NewUser!): User
      }
    `);
    const results = await scanner.scan(tempDir);
    const fields = results.flatMap((r) => r.routes);
    const labels = fields.map((f) => `${f.method} ${f.path}`);
    expect(labels).toEqual(expect.arrayContaining([
      'QUERY /graphql/user',
      'QUERY /graphql/users',
      'MUTATION /graphql/createUser',
    ]));
  });
});
