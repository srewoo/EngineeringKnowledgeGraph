import { describe, it, expect } from 'vitest';
import { GraphqlSdlExtractor } from '../../src/graphql.sdl.extractor.js';
import type { ApiNode } from '@ekg/shared';

const REPO = 'https://gitlab.com/acme/svc';

function findApi(apis: readonly ApiNode[], operationId: string): ApiNode | undefined {
  return apis.find((a) => (a.properties as { operationId?: string }).operationId === operationId);
}

describe('GraphqlSdlExtractor', () => {
  const extractor = new GraphqlSdlExtractor();

  describe('handlesByPath()', () => {
    it('matches .graphql / .gql', () => {
      expect(GraphqlSdlExtractor.handlesByPath('schema.graphql')).toBe(true);
      expect(GraphqlSdlExtractor.handlesByPath('a/b.gql')).toBe(true);
    });
    it('rejects unrelated extensions', () => {
      expect(GraphqlSdlExtractor.handlesByPath('schema.json')).toBe(false);
    });
  });

  describe('sniff()', () => {
    it('detects type Query', () => {
      expect(GraphqlSdlExtractor.sniff('type Query { ping: String }')).toBe(true);
    });
    it('detects extend type Query', () => {
      expect(GraphqlSdlExtractor.sniff('extend type Query {\n  user: User\n}')).toBe(true);
    });
    it('detects schema { ... }', () => {
      expect(GraphqlSdlExtractor.sniff('schema {\n  query: Query\n}\n')).toBe(true);
    });
    it('rejects unrelated content', () => {
      expect(GraphqlSdlExtractor.sniff('package main\nfunc main(){}')).toBe(false);
    });
  });

  it('emits one ApiNode per Query field with QUERY method', () => {
    const sdl = `
type Query {
  user(id: ID!): User
  ping: String
}
type User { id: ID! }
`;
    const { apis } = extractor.extract(sdl, 'svc/schema.graphql', REPO);
    expect(apis).toHaveLength(2);
    const userOp = findApi(apis, 'Query.user');
    expect(userOp).toBeDefined();
    const props = userOp!.properties as Record<string, unknown>;
    expect(props['method']).toBe('QUERY');
    expect(props['path']).toBe('user');
    expect(props['specVersion']).toBe('graphql-sdl');
    expect(props['specPath']).toBe('svc/schema.graphql');
    expect(userOp!.id).toBe(`api:${REPO}:Query.user`);
  });

  it('emits MUTATION fields with non-null return captured', () => {
    const sdl = `
type Mutation {
  createUser(input: CreateUserInput!): User!
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Mutation.createUser');
    expect(op).toBeDefined();
    const props = op!.properties as Record<string, unknown>;
    expect(props['method']).toBe('MUTATION');
    const responses = props['responseSchemas'] as Record<string, { type: string; nullable: boolean }>;
    expect(responses['200']!.type).toBe('User');
    expect(responses['200']!.nullable).toBe(false);
    const reqSchema = props['requestSchema'] as { args: Record<string, { type: string; nullable: boolean }> };
    expect(reqSchema.args['input']).toEqual({ type: 'CreateUserInput', nullable: false });
  });

  it('emits SUBSCRIPTION fields', () => {
    const sdl = `
type Subscription {
  onMessage(channel: String): Message
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Subscription.onMessage');
    expect(op).toBeDefined();
    expect((op!.properties as { method: string }).method).toBe('SUBSCRIPTION');
  });

  it('captures triple-quoted descriptions and uses first line as summary', () => {
    const sdl = `
type Query {
  """
  Look up a user by ID.
  Pull from the read replica.
  """
  user(id: ID!): User
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Query.user');
    const props = op!.properties as Record<string, unknown>;
    expect(props['summary']).toBe('Look up a user by ID.');
    expect(props['description']).toContain('Pull from the read replica.');
  });

  it('appends extend type Query fields', () => {
    const sdl = `
type Query {
  ping: String
}
extend type Query {
  health: String
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    expect(apis).toHaveLength(2);
    expect(findApi(apis, 'Query.ping')).toBeDefined();
    expect(findApi(apis, 'Query.health')).toBeDefined();
  });

  it('parses list return types like [Post!]!', () => {
    const sdl = `
type Query {
  posts: [Post!]!
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Query.posts');
    const responses = (op!.properties as Record<string, unknown>)['responseSchemas'] as Record<string, { type: string; nullable: boolean; list?: boolean }>;
    expect(responses['200']!.type).toBe('Post');
    expect(responses['200']!.nullable).toBe(false);
    expect(responses['200']!.list).toBe(true);
  });

  it('captures federation @key directive as a tag', () => {
    const sdl = `
type Query {
  product(id: ID!): Product @key(fields: "id")
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Query.product');
    const tags = (op!.properties as Record<string, unknown>)['tags'] as readonly string[];
    expect(tags).toContain('graphql');
    expect(tags).toContain('federated:@key');
  });

  it('captures default values on args', () => {
    const sdl = `
type Query {
  list(limit: Int = 10, offset: Int): [Item!]!
}
`;
    const { apis } = extractor.extract(sdl, 'schema.graphql', REPO);
    const op = findApi(apis, 'Query.list');
    const reqSchema = (op!.properties as Record<string, unknown>)['requestSchema'] as { args: Record<string, { type: string; nullable: boolean; defaultValue?: string }> };
    expect(reqSchema.args['limit']!.defaultValue).toBe('10');
    expect(reqSchema.args['limit']!.nullable).toBe(true);
    expect(reqSchema.args['offset']).toEqual({ type: 'Int', nullable: true });
  });

  it('returns empty apis for non-SDL content', () => {
    expect(extractor.extract('', 'x.graphql', REPO).apis).toHaveLength(0);
    expect(extractor.extract('not graphql at all', 'x.graphql', REPO).apis).toHaveLength(0);
  });
});
