/**
 * OpenApiExtractor — pure deterministic parser for OpenAPI 3.x / Swagger 2.0
 * specifications (JSON or YAML).
 *
 * Walks `paths.<path>.<method>` and emits one ApiNode per operation with
 * operationId, summary, description, tags, request schema (OpenAPI 3
 * `requestBody.content.<media>.schema`, Swagger 2 `parameters[in=body].schema`),
 * and response schemas keyed by status code.
 *
 * `$ref` strings are captured verbatim — cross-file resolution is deferred.
 *
 * Confidence is HIGH for spec-derived facts. The extractor is pure: it does
 * no I/O, no network, no LLM calls. Failure to parse returns `{ apis: [] }`
 * with a logged warning.
 */
import { extname, basename } from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { createLogger, type ApiNode, type ApiSpecVersion, type Logger } from '@ekg/shared';

export interface OpenApiExtractionResult {
  readonly apis: readonly ApiNode[];
  readonly specVersion?: ApiSpecVersion;
}

const HTTP_METHODS = new Set([
  'get', 'post', 'put', 'delete', 'patch', 'head', 'options',
]);

const SPEC_FILENAME_RE = /^(openapi|swagger)\.(json|ya?ml)$/i;
const SPEC_PATH_HINTS = ['/openapi/', '/swagger/'];
const SUPPORTED_EXTS = new Set(['.json', '.yaml', '.yml']);

interface RawSpecRoot {
  readonly openapi?: unknown;
  readonly swagger?: unknown;
  readonly paths?: Readonly<Record<string, unknown>>;
}

interface OperationLike {
  readonly operationId?: unknown;
  readonly summary?: unknown;
  readonly description?: unknown;
  readonly tags?: unknown;
  readonly requestBody?: unknown;
  readonly parameters?: unknown;
  readonly responses?: unknown;
}

export class OpenApiExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'openapi-extractor' });
  }

  /**
   * Filename-based detection. Catches `openapi.{json,yaml,yml}`,
   * `swagger.{json,yaml,yml}`, and any `.json/.yaml/.yml` file under a
   * path segment named `openapi` or `swagger`.
   */
  static handlesByPath(relativePath: string): boolean {
    const lower = relativePath.replace(/\\/g, '/').toLowerCase();
    if (SPEC_FILENAME_RE.test(basename(lower))) return true;
    const ext = extname(lower);
    if (!SUPPORTED_EXTS.has(ext)) return false;
    return SPEC_PATH_HINTS.some((hint) => lower.includes(hint));
  }

  /** True when extension is JSON/YAML and so worth content-sniffing. */
  static isSniffable(relativePath: string): boolean {
    return SUPPORTED_EXTS.has(extname(relativePath).toLowerCase());
  }

  /** Cheap content sniff — true if root has `openapi: 3.x` or `swagger: 2.0`. */
  static sniff(content: string): ApiSpecVersion | undefined {
    const root = safeParseRoot(content);
    return detectSpecVersion(root);
  }

  /**
   * Parse a spec file. `relativePath` is used for the spec node provenance.
   * Returns empty apis on parse error or unrecognised root shape.
   */
  extract(
    content: string,
    relativePath: string,
    repoUrl: string,
  ): OpenApiExtractionResult {
    const root = safeParseRoot(content);
    if (!root) {
      this.logger.warn({ path: relativePath }, 'Failed to parse spec content as JSON/YAML');
      return { apis: [] };
    }
    const specVersion = detectSpecVersion(root);
    if (!specVersion) {
      this.logger.warn(
        { path: relativePath },
        'Document is not an OpenAPI 3.x or Swagger 2.0 spec',
      );
      return { apis: [] };
    }

    const paths = isObject(root.paths) ? root.paths : undefined;
    if (!paths) {
      this.logger.warn({ path: relativePath, specVersion }, 'Spec has no paths object');
      return { apis: [], specVersion };
    }

    const apis: ApiNode[] = [];
    for (const [routePath, pathItem] of Object.entries(paths)) {
      if (!isObject(pathItem)) continue;
      for (const [methodKey, op] of Object.entries(pathItem)) {
        const method = methodKey.toLowerCase();
        if (!HTTP_METHODS.has(method)) continue;
        if (!isObject(op)) continue;
        apis.push(buildApiNode(
          op as OperationLike,
          method.toUpperCase(),
          routePath,
          repoUrl,
          relativePath,
          specVersion,
        ));
      }
    }

    return { apis, specVersion };
  }
}

// -- helpers ----------------------------------------------------------------

function buildApiNode(
  op: OperationLike,
  method: string,
  routePath: string,
  repoUrl: string,
  specPath: string,
  specVersion: ApiSpecVersion,
): ApiNode {
  const operationId = typeof op.operationId === 'string' ? op.operationId : undefined;
  const summary = typeof op.summary === 'string' ? op.summary : undefined;
  const description = typeof op.description === 'string' ? op.description : undefined;
  const tags = Array.isArray(op.tags)
    ? op.tags.filter((t): t is string => typeof t === 'string')
    : undefined;

  const requestSchema = specVersion === 'openapi-3'
    ? extractOpenApi3RequestSchema(op.requestBody)
    : extractSwagger2RequestSchema(op.parameters);

  const responseSchemas = extractResponseSchemas(op.responses, specVersion);

  const id = operationId
    ? `api:${repoUrl}:${operationId}`
    : `api:${method}:${routePath}`;

  const props: Record<string, unknown> = {
    method,
    path: routePath,
    framework: 'openapi',
    specVersion,
    specPath,
  };
  if (operationId) props['operationId'] = operationId;
  if (summary) props['summary'] = summary;
  if (description) props['description'] = description;
  if (tags && tags.length > 0) props['tags'] = tags;
  if (requestSchema !== undefined) props['requestSchema'] = requestSchema;
  if (responseSchemas && Object.keys(responseSchemas).length > 0) {
    props['responseSchemas'] = responseSchemas;
  }

  return {
    id,
    label: 'API',
    name: `${method} ${routePath}`,
    properties: props as ApiNode['properties'],
  };
}

function extractOpenApi3RequestSchema(requestBody: unknown): unknown {
  if (!isObject(requestBody)) return undefined;
  const content = requestBody['content'];
  if (!isObject(content)) return undefined;
  // Prefer application/json, otherwise first media type with a schema.
  const json = content['application/json'];
  const candidate = isObject(json) ? json : firstSchemaCarrier(content);
  if (!isObject(candidate)) return undefined;
  return candidate['schema'] ?? undefined;
}

function firstSchemaCarrier(content: Readonly<Record<string, unknown>>): unknown {
  for (const v of Object.values(content)) {
    if (isObject(v) && 'schema' in v) return v;
  }
  return undefined;
}

function extractSwagger2RequestSchema(parameters: unknown): unknown {
  if (!Array.isArray(parameters)) return undefined;
  for (const p of parameters) {
    if (!isObject(p)) continue;
    if (p['in'] === 'body') return p['schema'];
  }
  return undefined;
}

function extractResponseSchemas(
  responses: unknown,
  specVersion: ApiSpecVersion,
): Record<string, unknown> | undefined {
  if (!isObject(responses)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [status, resp] of Object.entries(responses)) {
    if (!isObject(resp)) continue;
    const schema = specVersion === 'openapi-3'
      ? extractOpenApi3ResponseSchema(resp)
      : resp['schema'];
    if (schema !== undefined) out[status] = schema;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function extractOpenApi3ResponseSchema(resp: Readonly<Record<string, unknown>>): unknown {
  const content = resp['content'];
  if (!isObject(content)) return undefined;
  const json = content['application/json'];
  const candidate = isObject(json) ? json : firstSchemaCarrier(content);
  if (!isObject(candidate)) return undefined;
  return candidate['schema'];
}

function detectSpecVersion(root: RawSpecRoot | undefined): ApiSpecVersion | undefined {
  if (!root) return undefined;
  if (typeof root.openapi === 'string' && root.openapi.startsWith('3.')) return 'openapi-3';
  if (typeof root.swagger === 'string' && root.swagger === '2.0') return 'swagger-2';
  return undefined;
}

function safeParseRoot(content: string): RawSpecRoot | undefined {
  const trimmed = content.trimStart();
  if (!trimmed) return undefined;
  // JSON first if it looks like JSON; otherwise YAML (which also handles JSON).
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(content) as unknown;
      return isObject(parsed) ? (parsed as RawSpecRoot) : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const parsed = yamlLoad(content) as unknown;
    return isObject(parsed) ? (parsed as RawSpecRoot) : undefined;
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
