/**
 * URL → API resolver (Phase 1.5 follow-ups).
 *
 * Pure deterministic matcher that links a `Function -[CALLS_API]-> API` edge
 * when an HTTP call site's URL can be resolved to a known API node.
 *
 * Inputs:
 *   - `httpCalls`  : enriched HTTP call sites from parser (one repo at a time).
 *   - `apis`       : known APIs to match against. Each carries `host` (optional)
 *                    and `pathTemplate` (e.g. `/api/v1/users/{id}`).
 *   - `serviceHosts`: optional config map service-name → known hostnames.
 *
 * Output:
 *   - `resolved` : edges to emit (apiId, callerSymbolId, confidence).
 *   - `unresolved`: HTTP calls we couldn't link, for the debugging MCP tool.
 *
 * Pure: no I/O, no LLM. The Neo4j-backed cross-repo lookup is in the
 * IngestionService — this module just does the matching once we have apis.
 */

export interface HttpCallInput {
  readonly url: string;
  readonly method: string;
  readonly callerSymbolId?: string;
  readonly sourceLine: number;
  readonly filePath: string;
  readonly isTemplate: boolean;
  readonly clientLibrary: string;
}

export interface ApiCandidate {
  readonly apiId: string;
  readonly serviceName?: string;
  readonly hosts: readonly string[];
  readonly method: string;
  readonly pathTemplate: string;
}

export interface ResolvedApiCall {
  readonly apiId: string;
  readonly call: HttpCallInput;
  readonly confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  readonly reason: string;
}

export interface UnresolvedHttpCall extends HttpCallInput {
  readonly reason: string;
}

export interface UrlResolverInput {
  readonly httpCalls: readonly HttpCallInput[];
  readonly apis: readonly ApiCandidate[];
  readonly serviceHosts?: Readonly<Record<string, readonly string[]>>;
  readonly strict?: boolean;
}

export interface UrlResolverResult {
  readonly resolved: readonly ResolvedApiCall[];
  readonly unresolved: readonly UnresolvedHttpCall[];
}

const COMMON_HOST_SUFFIXES = ['-service', '-api', '-svc', '.local', '.cluster.local', '.internal'];

export class UrlApiResolver {
  resolve(input: UrlResolverInput): UrlResolverResult {
    const resolved: ResolvedApiCall[] = [];
    const unresolved: UnresolvedHttpCall[] = [];
    const apisByMethod = indexByMethod(input.apis);

    for (const call of input.httpCalls) {
      const out = this.matchOne(call, apisByMethod, input.serviceHosts);
      if (out) {
        if (out.confidence === 'LOW' && input.strict) {
          unresolved.push({ ...call, reason: out.reason });
        } else {
          resolved.push(out);
        }
      } else {
        unresolved.push({ ...call, reason: 'no-match' });
      }
    }

    return { resolved, unresolved };
  }

  private matchOne(
    call: HttpCallInput,
    apisByMethod: ReadonlyMap<string, readonly ApiCandidate[]>,
    serviceHosts?: Readonly<Record<string, readonly string[]>>,
  ): ResolvedApiCall | undefined {
    const parsed = parseUrl(call.url);
    if (!parsed) return undefined;
    const candidates = apisByMethod.get(call.method.toUpperCase()) ?? [];
    if (candidates.length === 0) return undefined;

    const pathMatches = candidates.filter((c) => pathMatches1(parsed.path, c.pathTemplate));
    if (pathMatches.length === 0) return undefined;

    // Host match — exact via config, then fuzzy.
    if (parsed.host) {
      const exact = pickByExactHost(pathMatches, parsed.host, serviceHosts);
      if (exact) {
        return {
          apiId: exact.apiId,
          call,
          confidence: pathMatches.length === 1 ? 'HIGH' : 'MEDIUM',
          reason: 'exact-host+path',
        };
      }
      const fuzzy = pickByFuzzyHost(pathMatches, parsed.host);
      if (fuzzy) {
        return {
          apiId: fuzzy.apiId,
          call,
          confidence: 'MEDIUM',
          reason: 'fuzzy-host+path',
        };
      }
    }

    // Template URL with no host (e.g. `${baseUrl}/api/v1/users/${id}`):
    // trust path-only when uniquely matched, otherwise pick the most specific.
    if (call.isTemplate || !parsed.host) {
      const best = pickMostSpecific(pathMatches);
      return {
        apiId: best.apiId,
        call,
        confidence: pathMatches.length === 1 ? 'MEDIUM' : 'MEDIUM',
        reason: pathMatches.length === 1 ? 'template-path-unique' : 'template-path-multi',
      };
    }

    // Path matched but host didn't — LOW.
    const best = pickMostSpecific(pathMatches);
    return {
      apiId: best.apiId,
      call,
      confidence: 'LOW',
      reason: 'path-only-no-host-match',
    };
  }
}

function indexByMethod(apis: readonly ApiCandidate[]): ReadonlyMap<string, readonly ApiCandidate[]> {
  const out = new Map<string, ApiCandidate[]>();
  for (const a of apis) {
    const k = a.method.toUpperCase();
    let bucket = out.get(k);
    if (!bucket) { bucket = []; out.set(k, bucket); }
    bucket.push(a);
  }
  return out;
}

interface ParsedUrl { readonly host: string; readonly path: string; }

function parseUrl(url: string): ParsedUrl | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return { host: '', path: stripQuery(url) };
  if (url.startsWith('{var}')) {
    // Template literal — strip the leading placeholder; whatever follows
    // is a path fragment we can match on.
    const rest = url.slice('{var}'.length);
    const path = rest.startsWith('/') ? stripQuery(rest) : `/${stripQuery(rest)}`;
    return { host: '', path };
  }
  try {
    const u = new URL(url.replace(/\{var\}/g, 'X'));
    return { host: u.hostname, path: stripQuery(u.pathname) };
  } catch {
    return undefined;
  }
}

function stripQuery(p: string): string {
  const q = p.indexOf('?');
  return (q === -1 ? p : p.slice(0, q)) || '/';
}

/** Convert `/api/v1/users/{id}` → regex segments and test. */
function pathMatches1(callPath: string, template: string): boolean {
  const segments = template.split('/').filter(Boolean);
  const callSegments = callPath.split('/').filter(Boolean);
  if (segments.length !== callSegments.length) return false;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const isParam = (seg.startsWith('{') && seg.endsWith('}'))
      || seg.startsWith(':')
      || seg === '{var}';
    if (isParam) continue;
    const callSeg = callSegments[i]!;
    if (callSeg === '{var}') continue;
    if (seg !== callSeg) return false;
  }
  return true;
}

function pickByExactHost(
  cands: readonly ApiCandidate[],
  host: string,
  serviceHosts?: Readonly<Record<string, readonly string[]>>,
): ApiCandidate | undefined {
  const hostLower = host.toLowerCase();
  for (const c of cands) {
    if (c.hosts.some((h) => h.toLowerCase() === hostLower)) return c;
  }
  if (serviceHosts) {
    for (const c of cands) {
      if (!c.serviceName) continue;
      const svcHosts = serviceHosts[c.serviceName];
      if (svcHosts?.some((h) => h.toLowerCase() === hostLower)) return c;
    }
  }
  return undefined;
}

function pickByFuzzyHost(cands: readonly ApiCandidate[], host: string): ApiCandidate | undefined {
  const stripped = stripCommonHostSuffixes(host.toLowerCase());
  for (const c of cands) {
    if (!c.serviceName) continue;
    const svc = stripCommonHostSuffixes(c.serviceName.toLowerCase());
    if (stripped.includes(svc) || svc.includes(stripped)) return c;
  }
  return undefined;
}

function stripCommonHostSuffixes(s: string): string {
  let out = s;
  for (const suffix of COMMON_HOST_SUFFIXES) {
    if (out.endsWith(suffix)) out = out.slice(0, -suffix.length);
  }
  // Strip first DNS label if it has dots, e.g. host.api.example.com → host
  const dot = out.indexOf('.');
  if (dot !== -1) out = out.slice(0, dot);
  return out;
}

function pickMostSpecific(cands: readonly ApiCandidate[]): ApiCandidate {
  // Specificity = literal-segment count (params don't count).
  let best = cands[0]!;
  let bestScore = literalSegments(best.pathTemplate);
  for (let i = 1; i < cands.length; i++) {
    const score = literalSegments(cands[i]!.pathTemplate);
    if (score > bestScore) { best = cands[i]!; bestScore = score; }
  }
  return best;
}

function literalSegments(template: string): number {
  let n = 0;
  for (const seg of template.split('/').filter(Boolean)) {
    if (!(seg.startsWith('{') || seg.startsWith(':'))) n++;
  }
  return n;
}
