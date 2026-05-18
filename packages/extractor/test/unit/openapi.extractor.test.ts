import { describe, it, expect } from 'vitest';
import { OpenApiExtractor } from '../../src/openapi.extractor.js';
import type { ApiNode } from '@ekg/shared';

const REPO = 'https://gitlab.com/acme/svc';

const OPENAPI_3_YAML = `
openapi: 3.0.3
info:
  title: Pet Store
  version: 1.0.0
paths:
  /pets:
    get:
      operationId: listPets
      summary: List all pets
      tags: [pets, public]
      responses:
        '200':
          description: ok
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PetList'
    post:
      operationId: createPet
      summary: Create a pet
      tags: [pets]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/Pet'
      responses:
        '201':
          description: created
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
        '400':
          description: bad input
  /pets/{id}:
    get:
      summary: Get a pet
      responses:
        '200':
          description: ok
  /healthz:
    get:
      operationId: healthCheck
      responses:
        '200': { description: ok }
`;

const SWAGGER_2_JSON = JSON.stringify({
  swagger: '2.0',
  info: { title: 'Legacy', version: '1' },
  paths: {
    '/users': {
      post: {
        operationId: 'createUser',
        summary: 'Create user',
        tags: ['users'],
        parameters: [
          { name: 'body', in: 'body', required: true, schema: { $ref: '#/definitions/User' } },
        ],
        responses: {
          '201': { description: 'created', schema: { $ref: '#/definitions/User' } },
        },
      },
      get: {
        operationId: 'listUsers',
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

function findApi(apis: readonly ApiNode[], method: string, path: string): ApiNode | undefined {
  return apis.find((a) => {
    const p = a.properties as { method: string; path: string };
    return p.method === method && p.path === path;
  });
}

describe('OpenApiExtractor', () => {
  const extractor = new OpenApiExtractor();

  describe('handlesByPath()', () => {
    it('matches openapi.yaml / swagger.json by basename', () => {
      expect(OpenApiExtractor.handlesByPath('docs/openapi.yaml')).toBe(true);
      expect(OpenApiExtractor.handlesByPath('SWAGGER.JSON')).toBe(true);
      expect(OpenApiExtractor.handlesByPath('spec/openapi.yml')).toBe(true);
    });

    it('matches files under /openapi/ or /swagger/ path segments', () => {
      expect(OpenApiExtractor.handlesByPath('api/openapi/v1.yaml')).toBe(true);
      expect(OpenApiExtractor.handlesByPath('docs/swagger/petstore.json')).toBe(true);
    });

    it('rejects unrelated yaml/json files', () => {
      expect(OpenApiExtractor.handlesByPath('config/app.yaml')).toBe(false);
      expect(OpenApiExtractor.handlesByPath('package.json')).toBe(false);
    });
  });

  describe('sniff()', () => {
    it('detects openapi 3 from YAML root', () => {
      expect(OpenApiExtractor.sniff('openapi: 3.0.3\npaths: {}\n')).toBe('openapi-3');
    });

    it('detects swagger 2 from JSON root', () => {
      expect(OpenApiExtractor.sniff('{"swagger":"2.0","paths":{}}')).toBe('swagger-2');
    });

    it('returns undefined for non-spec yaml', () => {
      expect(OpenApiExtractor.sniff('foo: bar\nbaz: 1\n')).toBeUndefined();
    });

    it('returns undefined for invalid content', () => {
      expect(OpenApiExtractor.sniff(':::not yaml')).toBeUndefined();
      expect(OpenApiExtractor.sniff('')).toBeUndefined();
    });
  });

  describe('OpenAPI 3.x extraction', () => {
    it('emits one API node per (path, method)', () => {
      const { apis, specVersion } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      expect(specVersion).toBe('openapi-3');
      // GET /pets, POST /pets, GET /pets/{id}, GET /healthz
      expect(apis).toHaveLength(4);
    });

    it('captures operationId, summary, and tags', () => {
      const { apis } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      const listPets = findApi(apis, 'GET', '/pets');
      expect(listPets).toBeDefined();
      const props = listPets!.properties as Record<string, unknown>;
      expect(props['operationId']).toBe('listPets');
      expect(props['summary']).toBe('List all pets');
      expect(props['tags']).toEqual(['pets', 'public']);
      expect(props['specVersion']).toBe('openapi-3');
      expect(props['specPath']).toBe('docs/openapi.yaml');
    });

    it('captures requestBody schema and response schemas keyed by status', () => {
      const { apis } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      const createPet = findApi(apis, 'POST', '/pets');
      expect(createPet).toBeDefined();
      const props = createPet!.properties as Record<string, unknown>;
      // Schemas are JSON-stringified for Neo4j compatibility.
      expect(JSON.parse(props['requestSchema'] as string)).toEqual({ $ref: '#/components/schemas/Pet' });
      const responses = JSON.parse(props['responseSchemas'] as string) as Record<string, unknown>;
      expect(responses['201']).toEqual({ $ref: '#/components/schemas/Pet' });
      // 400 has no content, so no entry.
      expect(responses['400']).toBeUndefined();
    });

    it('captures $ref strings verbatim (no resolution)', () => {
      const { apis } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      const listPets = findApi(apis, 'GET', '/pets');
      const responses = JSON.parse((listPets!.properties as Record<string, unknown>)['responseSchemas'] as string) as Record<string, unknown>;
      expect(responses['200']).toEqual({ $ref: '#/components/schemas/PetList' });
    });

    it('falls back to method+path id when operationId is missing', () => {
      const { apis } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      const getPet = findApi(apis, 'GET', '/pets/{id}');
      expect(getPet).toBeDefined();
      expect(getPet!.id).toBe('api:GET:/pets/{id}');
    });

    it('uses operationId-scoped id when present', () => {
      const { apis } = extractor.extract(OPENAPI_3_YAML, 'docs/openapi.yaml', REPO);
      const listPets = findApi(apis, 'GET', '/pets');
      expect(listPets!.id).toBe(`api:${REPO}:listPets`);
    });
  });

  describe('Swagger 2.0 extraction', () => {
    it('parses paths and method ops from JSON', () => {
      const { apis, specVersion } = extractor.extract(SWAGGER_2_JSON, 'swagger.json', REPO);
      expect(specVersion).toBe('swagger-2');
      expect(apis).toHaveLength(2);
    });

    it('extracts body parameter schema as requestSchema', () => {
      const { apis } = extractor.extract(SWAGGER_2_JSON, 'swagger.json', REPO);
      const createUser = findApi(apis, 'POST', '/users');
      const props = createUser!.properties as Record<string, unknown>;
      expect(JSON.parse(props['requestSchema'] as string)).toEqual({ $ref: '#/definitions/User' });
      const responses = JSON.parse(props['responseSchemas'] as string) as Record<string, unknown>;
      expect(responses['201']).toEqual({ $ref: '#/definitions/User' });
      expect(props['specVersion']).toBe('swagger-2');
    });
  });

  describe('Edge cases', () => {
    it('returns empty apis for empty content', () => {
      const r = extractor.extract('', 'spec.yaml', REPO);
      expect(r.apis).toHaveLength(0);
      expect(r.specVersion).toBeUndefined();
    });

    it('returns empty apis for invalid YAML', () => {
      const r = extractor.extract('::: not valid yaml :::\n  - [', 'spec.yaml', REPO);
      expect(r.apis).toHaveLength(0);
    });

    it('returns empty apis for non-spec YAML (no openapi/swagger key)', () => {
      const r = extractor.extract('foo: bar\nbaz: 1\n', 'random.yaml', REPO);
      expect(r.apis).toHaveLength(0);
    });

    it('returns empty apis for spec without paths', () => {
      const r = extractor.extract('openapi: 3.0.0\ninfo: { title: x, version: 1 }\n', 'spec.yaml', REPO);
      expect(r.apis).toHaveLength(0);
      expect(r.specVersion).toBe('openapi-3');
    });

    it('skips non-HTTP-method keys at the path level (e.g. parameters, summary)', () => {
      const yaml = `openapi: 3.0.0
paths:
  /a:
    summary: shared summary
    parameters: []
    get:
      responses: { '200': { description: ok } }
`;
      const { apis } = extractor.extract(yaml, 'spec.yaml', REPO);
      expect(apis).toHaveLength(1);
      expect((apis[0]!.properties as { method: string }).method).toBe('GET');
    });
  });
});
