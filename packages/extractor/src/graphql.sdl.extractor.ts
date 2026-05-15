/**
 * GraphqlSdlExtractor — pure deterministic parser for GraphQL SDL files.
 *
 * Walks `type Query { ... }`, `type Mutation { ... }`, `type Subscription { ... }`
 * and the corresponding `extend type` blocks, emitting one ApiNode per field.
 *
 * Federation directives (`@key`, `@external`, `@requires`, `@provides`,
 * `@shareable`) are captured as `tags` of the form `federated:@key`.
 *
 * The extractor is deliberately regex/line-based — depending on the heavy
 * `graphql` package would inflate the install for very little gain. Returns
 * `{ apis: [] }` for malformed SDL.
 */
import { extname } from 'node:path';
import { createLogger, type ApiNode, type Logger } from '@ekg/shared';

export interface GraphqlSdlExtractionResult {
  readonly apis: readonly ApiNode[];
}

type RootKind = 'QUERY' | 'MUTATION' | 'SUBSCRIPTION';
const ROOT_TYPES: ReadonlyMap<string, RootKind> = new Map([
  ['Query', 'QUERY'],
  ['Mutation', 'MUTATION'],
  ['Subscription', 'SUBSCRIPTION'],
]);

const SDL_EXTENSIONS = new Set(['.graphql', '.gql', '.graphqls']);
// `(?:^|\n)` so we don't trip on the keyword inside an arbitrary string.
const SNIFF_RE = /(?:^|\n)\s*(?:schema\s*\{|extend\s+type\s+(?:Query|Mutation|Subscription)\b|type\s+(?:Query|Mutation|Subscription)\b)/;

const FEDERATION_DIRECTIVES = ['@key', '@external', '@requires', '@provides', '@shareable', '@extends'];

interface FieldArg {
  readonly type: string;
  readonly nullable: boolean;
  readonly list?: boolean;
  readonly defaultValue?: string;
}

interface ParsedField {
  readonly rootKind: RootKind;
  readonly typeName: string; // 'Query' | 'Mutation' | 'Subscription'
  readonly fieldName: string;
  readonly args: Readonly<Record<string, FieldArg>>;
  readonly returnType: string;
  readonly returnNullable: boolean;
  readonly returnList: boolean;
  readonly description?: string;
  readonly federationTags: readonly string[];
}

export class GraphqlSdlExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'graphql-sdl-extractor' });
  }

  static handlesByPath(relativePath: string): boolean {
    return SDL_EXTENSIONS.has(extname(relativePath).toLowerCase());
  }

  /** Cheap sniff for files without a `.graphql` extension. */
  static sniff(content: string): boolean {
    if (!content) return false;
    return SNIFF_RE.test(content);
  }

  extract(content: string, relativePath: string, repoUrl: string): GraphqlSdlExtractionResult {
    if (!content) return { apis: [] };
    let fields: readonly ParsedField[];
    try {
      fields = parseSdl(content);
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse GraphQL SDL');
      return { apis: [] };
    }
    const apis: ApiNode[] = fields.map((f) => this.toApiNode(f, repoUrl, relativePath));
    return { apis };
  }

  private toApiNode(field: ParsedField, repoUrl: string, specPath: string): ApiNode {
    const operationId = `${field.typeName}.${field.fieldName}`;
    const tags = ['graphql', ...field.federationTags];
    const summary = field.description ? field.description.split('\n', 1)[0] : undefined;
    const requestSchema = { args: field.args };
    const responseSchemas: Record<string, unknown> = {
      '200': {
        type: field.returnType,
        nullable: field.returnNullable,
        ...(field.returnList ? { list: true } : {}),
      },
    };

    const props: Record<string, unknown> = {
      method: field.rootKind,
      path: field.fieldName,
      framework: 'graphql',
      operationId,
      tags,
      requestSchema,
      responseSchemas,
      specVersion: 'graphql-sdl',
      specPath,
    };
    if (summary) props['summary'] = summary;
    if (field.description) props['description'] = field.description;

    return {
      id: `api:${repoUrl}:${operationId}`,
      label: 'API',
      name: `${field.rootKind} ${field.fieldName}`,
      properties: props as ApiNode['properties'],
    };
  }
}

// -- parser -----------------------------------------------------------------

/**
 * Strip `# line comments` (but keep `"""..."""` and `"..."` descriptions).
 * Then walk top-level `type X` / `extend type X` blocks, emitting fields for
 * the three operation root types.
 */
function parseSdl(input: string): readonly ParsedField[] {
  const stripped = stripLineComments(input);
  const fields: ParsedField[] = [];
  // Regex matches block headers; we then balance braces by hand.
  const blockHeader = /(?:^|\n)\s*(?:extend\s+)?type\s+(Query|Mutation|Subscription)\b[^{]*\{/g;
  for (;;) {
    const match = blockHeader.exec(stripped);
    if (!match) break;
    const typeName = match[1]!;
    const rootKind = ROOT_TYPES.get(typeName)!;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = findMatchingBrace(stripped, bodyStart - 1);
    if (bodyEnd === -1) break;
    const body = stripped.slice(bodyStart, bodyEnd);
    fields.push(...parseFields(body, typeName, rootKind));
    blockHeader.lastIndex = bodyEnd + 1;
  }
  return fields;
}

function stripLineComments(input: string): string {
  // Remove `# ...` to end-of-line, except inside `"""..."""` or `"..."`.
  // Cheap state machine.
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '"' && input.startsWith('"""', i)) {
      const end = input.indexOf('"""', i + 3);
      if (end === -1) { out += input.slice(i); break; }
      out += input.slice(i, end + 3);
      i = end + 3;
      continue;
    }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) { out += input.slice(i); break; }
      out += input.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '#') {
      const nl = input.indexOf('\n', i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findMatchingBrace(src: string, openIdx: number): number {
  // Walk forward, tracking nested braces; ignore braces inside strings.
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' && src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      if (end === -1) return -1;
      i = end + 3;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

interface RawFieldChunk {
  readonly description?: string;
  readonly source: string;
}

function parseFields(body: string, typeName: string, rootKind: RootKind): ParsedField[] {
  const chunks = splitFieldChunks(body);
  const out: ParsedField[] = [];
  for (const chunk of chunks) {
    const parsed = parseSingleField(chunk, typeName, rootKind);
    if (parsed) out.push(parsed);
  }
  return out;
}

/**
 * Split a body block into per-field chunks, attaching any preceding
 * `"""..."""` / `"..."` description string to the next field.
 */
function splitFieldChunks(body: string): readonly RawFieldChunk[] {
  const chunks: RawFieldChunk[] = [];
  let i = 0;
  let pendingDesc: string | undefined;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i]!)) i++;
    if (i >= body.length) break;

    if (body.startsWith('"""', i)) {
      const end = body.indexOf('"""', i + 3);
      if (end === -1) break;
      pendingDesc = body.slice(i + 3, end).trim();
      i = end + 3;
      continue;
    }
    if (body[i] === '"') {
      const end = body.indexOf('"', i + 1);
      if (end === -1) break;
      pendingDesc = body.slice(i + 1, end).trim();
      i = end + 1;
      continue;
    }

    const fieldStart = i;
    const fieldEnd = findFieldEnd(body, i);
    const source = body.slice(fieldStart, fieldEnd).trim();
    if (source) {
      chunks.push(pendingDesc ? { description: pendingDesc, source } : { source });
    }
    pendingDesc = undefined;
    i = fieldEnd;
  }
  return chunks;
}

/**
 * A field ends at the next newline that is at depth 0 (ignoring the parens
 * around args). We also stop at a `}` (defensive — body shouldn't contain it).
 */
function findFieldEnd(body: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < body.length) {
    const ch = body[i]!;
    if (ch === '"' && body.startsWith('"""', i)) {
      const end = body.indexOf('"""', i + 3);
      if (end === -1) return body.length;
      i = end + 3;
      continue;
    }
    if (ch === '"') {
      const end = body.indexOf('"', i + 1);
      if (end === -1) return body.length;
      i = end + 1;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '\n' && depth === 0) return i;
    i++;
  }
  return body.length;
}

const FIELD_HEAD_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\([\s\S]*?\))?\s*:\s*([^@\n]+?)\s*(@.*)?$/;

function parseSingleField(chunk: RawFieldChunk, typeName: string, rootKind: RootKind): ParsedField | undefined {
  const oneLine = chunk.source.replace(/\s+/g, ' ').trim();
  const m = FIELD_HEAD_RE.exec(oneLine);
  if (!m) return undefined;
  const fieldName = m[1]!;
  const argsBlock = m[2];
  const returnTypeRaw = m[3]!.trim();
  const directives = m[4] ?? '';

  const args = argsBlock ? parseArgs(argsBlock.slice(1, -1)) : {};
  const { type, nullable, list } = parseTypeRef(returnTypeRaw);
  const federationTags = extractFederationTags(directives);

  const out: ParsedField = {
    rootKind,
    typeName,
    fieldName,
    args,
    returnType: type,
    returnNullable: nullable,
    returnList: list,
    federationTags,
    ...(chunk.description ? { description: chunk.description } : {}),
  };
  return out;
}

function parseArgs(inner: string): Record<string, FieldArg> {
  const out: Record<string, FieldArg> = {};
  // Split on top-level commas. Args don't nest beyond `[...]` and `{...}`.
  const parts = splitTopLevel(inner, ',');
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const name = trimmed.slice(0, colon).trim();
    const rest = trimmed.slice(colon + 1).trim();
    // strip directives
    const noDirective = rest.split(/\s@/)[0]!.trim();
    const eq = splitOnTopLevelEquals(noDirective);
    const typeRaw = eq.lhs.trim();
    const def = eq.rhs?.trim();
    const ref = parseTypeRef(typeRaw);
    out[name] = {
      type: ref.type,
      nullable: ref.nullable,
      ...(ref.list ? { list: true } : {}),
      ...(def !== undefined ? { defaultValue: def } : {}),
    };
  }
  return out;
}

function splitTopLevel(input: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === sep && depth === 0) {
      out.push(input.slice(start, i));
      start = i + 1;
    }
  }
  out.push(input.slice(start));
  return out;
}

function splitOnTopLevelEquals(input: string): { lhs: string; rhs?: string } {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) {
      return { lhs: input.slice(0, i), rhs: input.slice(i + 1) };
    }
  }
  return { lhs: input };
}

function parseTypeRef(raw: string): { type: string; nullable: boolean; list: boolean } {
  let s = raw.trim();
  const nullable = !s.endsWith('!');
  if (!nullable) s = s.slice(0, -1).trim();
  let list = false;
  if (s.startsWith('[') && s.endsWith(']')) {
    list = true;
    let inner = s.slice(1, -1).trim();
    if (inner.endsWith('!')) inner = inner.slice(0, -1).trim();
    s = inner;
  }
  return { type: s, nullable, list };
}

function extractFederationTags(directives: string): readonly string[] {
  if (!directives) return [];
  const tags: string[] = [];
  for (const dir of FEDERATION_DIRECTIVES) {
    // Match the directive keyword followed by either end-of-string, whitespace, or `(`.
    const re = new RegExp(`${dir.replace('@', '\\@')}(?=$|[\\s(])`);
    if (re.test(directives)) tags.push(`federated:${dir}`);
  }
  return tags;
}
