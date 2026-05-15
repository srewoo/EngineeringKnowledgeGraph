/**
 * GrpcProtoExtractor — pure deterministic parser for protobuf `.proto` files.
 *
 * Walks each `service Name { ... }` block and emits one ApiNode per `rpc`
 * method, capturing streaming on either side. Adds the package prefix to the
 * canonical gRPC URL form (`/<package>.<Service>/<Method>`).
 *
 * Regex-based — `protobufjs` would be heavy for what we need (signatures only).
 * Returns `{ apis: [] }` for malformed proto.
 */
import { extname } from 'node:path';
import { createLogger, type ApiNode, type ApiSpecVersion, type Logger } from '@ekg/shared';

export interface GrpcProtoExtractionResult {
  readonly apis: readonly ApiNode[];
}

export type GrpcMethod =
  | 'GRPC_UNARY'
  | 'GRPC_SERVER_STREAM'
  | 'GRPC_CLIENT_STREAM'
  | 'GRPC_BIDI_STREAM';

interface ParsedRpc {
  readonly serviceName: string;
  readonly methodName: string;
  readonly requestType: string;
  readonly responseType: string;
  readonly clientStreaming: boolean;
  readonly serverStreaming: boolean;
  readonly description?: string;
}

const PROTO_EXT = '.proto';

const PACKAGE_RE = /(?:^|\n)\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/;
const SYNTAX_RE = /(?:^|\n)\s*syntax\s*=\s*"(proto2|proto3)"\s*;/;
const SERVICE_HEADER_RE = /(?:^|\n)\s*service\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
// Match `rpc Name(stream? Req) returns (stream? Resp);` — body (`{...}`) optional.
const RPC_RE = /rpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*returns\s*\(\s*(stream\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*\)\s*(?:\{[^}]*\}|;)/g;

export class GrpcProtoExtractor {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'grpc-proto-extractor' });
  }

  static handlesByPath(relativePath: string): boolean {
    return extname(relativePath).toLowerCase() === PROTO_EXT;
  }

  extract(content: string, relativePath: string, repoUrl: string): GrpcProtoExtractionResult {
    if (!content) return { apis: [] };
    let parsed: { rpcs: readonly ParsedRpc[]; pkg?: string; specVersion: ApiSpecVersion };
    try {
      parsed = parseProto(content);
    } catch (err) {
      this.logger.warn({ err, path: relativePath }, 'Failed to parse .proto file');
      return { apis: [] };
    }
    const apis: ApiNode[] = parsed.rpcs.map((r) =>
      this.toApiNode(r, parsed.pkg, parsed.specVersion, repoUrl, relativePath),
    );
    return { apis };
  }

  private toApiNode(
    rpc: ParsedRpc,
    pkg: string | undefined,
    specVersion: ApiSpecVersion,
    repoUrl: string,
    specPath: string,
  ): ApiNode {
    const method = classifyMethod(rpc.clientStreaming, rpc.serverStreaming);
    const fqService = pkg ? `${pkg}.${rpc.serviceName}` : rpc.serviceName;
    const path = pkg
      ? `/${fqService}/${rpc.methodName}`
      : `${rpc.serviceName}/${rpc.methodName}`;
    const operationId = `${rpc.serviceName}.${rpc.methodName}`;
    const summary = rpc.description ? rpc.description.split('\n', 1)[0] : undefined;

    const props: Record<string, unknown> = {
      method,
      path,
      framework: 'grpc',
      operationId,
      tags: ['grpc'],
      requestSchema: { messageType: rpc.requestType },
      responseSchemas: { '200': { messageType: rpc.responseType } },
      specVersion,
      specPath,
    };
    if (summary) props['summary'] = summary;
    if (rpc.description) props['description'] = rpc.description;

    return {
      id: `api:${repoUrl}:${operationId}`,
      label: 'API',
      name: `${method} ${path}`,
      properties: props as ApiNode['properties'],
    };
  }
}

// -- parser -----------------------------------------------------------------

function parseProto(content: string): {
  rpcs: readonly ParsedRpc[];
  pkg?: string;
  specVersion: ApiSpecVersion;
} {
  const stripped = stripCommentsKeepDocs(content);
  const pkg = PACKAGE_RE.exec(stripped)?.[1];
  const syntax = SYNTAX_RE.exec(stripped)?.[1];
  const specVersion: ApiSpecVersion = syntax === 'proto2' ? 'grpc-proto2' : 'grpc-proto3';

  const rpcs: ParsedRpc[] = [];
  SERVICE_HEADER_RE.lastIndex = 0;
  for (;;) {
    const sm = SERVICE_HEADER_RE.exec(stripped);
    if (!sm) break;
    const serviceName = sm[1]!;
    const bodyStart = sm.index + sm[0].length;
    const bodyEnd = findMatchingBrace(stripped, bodyStart - 1);
    if (bodyEnd === -1) break;
    const body = stripped.slice(bodyStart, bodyEnd);
    rpcs.push(...parseRpcsFromBody(body, serviceName, content, bodyStart));
    SERVICE_HEADER_RE.lastIndex = bodyEnd + 1;
  }
  const result: { rpcs: readonly ParsedRpc[]; pkg?: string; specVersion: ApiSpecVersion } =
    pkg ? { rpcs, pkg, specVersion } : { rpcs, specVersion };
  return result;
}

function parseRpcsFromBody(
  body: string,
  serviceName: string,
  rawContent: string,
  bodyOffsetInRaw: number,
): ParsedRpc[] {
  const out: ParsedRpc[] = [];
  RPC_RE.lastIndex = 0;
  for (;;) {
    const m = RPC_RE.exec(body);
    if (!m) break;
    const description = collectPrecedingDoc(rawContent, bodyOffsetInRaw + m.index);
    const rpc: ParsedRpc = {
      serviceName,
      methodName: m[1]!,
      requestType: m[3]!,
      responseType: m[5]!,
      clientStreaming: !!m[2],
      serverStreaming: !!m[4],
      ...(description ? { description } : {}),
    };
    out.push(rpc);
  }
  return out;
}

/**
 * Find the contiguous block of `// ...` lines immediately preceding the
 * given offset (in the original, pre-stripped source). Returns the joined
 * comment text or undefined when no doc is present.
 */
function collectPrecedingDoc(src: string, offset: number): string | undefined {
  // Walk backwards over whitespace to the previous newline.
  let i = offset;
  while (i > 0 && src[i - 1] !== '\n') i--;
  // Now `i` is the start of the rpc's line. Walk lines upward.
  const docs: string[] = [];
  let lineEnd = i; // exclusive end of the previous line
  while (lineEnd > 0) {
    let lineStart = lineEnd - 1;
    while (lineStart > 0 && src[lineStart - 1] !== '\n') lineStart--;
    const line = src.slice(lineStart, lineEnd - 1).trim();
    if (line.startsWith('//')) {
      docs.unshift(line.replace(/^\/\/\s?/, ''));
      lineEnd = lineStart;
    } else {
      break;
    }
  }
  return docs.length > 0 ? docs.join('\n') : undefined;
}

/**
 * Strip block `/* ... *\/` comments. Preserve `// ...` line comments so
 * `collectPrecedingDoc` can recover them on the original source.
 */
function stripCommentsKeepDocs(input: string): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end === -1) { out += input.slice(i); break; }
      out += input.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '/' && input[i + 1] === '*') {
      const end = input.indexOf('*/', i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function findMatchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
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

function classifyMethod(client: boolean, server: boolean): GrpcMethod {
  if (client && server) return 'GRPC_BIDI_STREAM';
  if (client) return 'GRPC_CLIENT_STREAM';
  if (server) return 'GRPC_SERVER_STREAM';
  return 'GRPC_UNARY';
}
