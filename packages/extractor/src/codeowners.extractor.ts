/**
 * CODEOWNERS post-extraction pass (Phase 1.7).
 *
 * Pure function. Given the raw CODEOWNERS content + the list of File node IDs
 * already emitted for a repo, produces:
 *   - `Owner` nodes (user / email) with identifier + kind
 *   - `Team` nodes (`@org/team`)
 *   - `File -[OWNED_BY]-> Owner|Team` edges per CODEOWNERS spec
 *     (last matching rule wins per file).
 *
 * The original `MetadataScanner.emitOwnerNodes` flow already emits coarse
 * `Owner OWNS Service` edges from CODEOWNERS prefix matches. This extractor
 * adds the missing per-file fan-out + the richer node properties the LLM
 * router relies on (`identifier`, `kind`).
 */

import type {
  GraphNode, GraphRelationship, OwnerKind, OwnerNode, TeamNode,
} from '@ekg/shared';
import type { CodeOwnerRule } from '@ekg/parser';

export interface CodeownersExtractionInput {
  readonly rules: readonly CodeOwnerRule[];
  readonly repoUrl: string;
  /** Each entry: { fileId (graph id used by File nodes), relativePath }. */
  readonly repoFiles: readonly { readonly fileId: string; readonly relativePath: string }[];
}

export interface CodeownersExtractionResult {
  readonly owners: readonly OwnerNode[];
  readonly teams: readonly TeamNode[];
  readonly relationships: readonly GraphRelationship[];
}

export class CodeownersExtractor {
  extract(input: CodeownersExtractionInput): CodeownersExtractionResult {
    const { rules, repoUrl, repoFiles } = input;
    if (rules.length === 0 || repoFiles.length === 0) {
      return { owners: [], teams: [], relationships: [] };
    }

    const ownerNodes = new Map<string, OwnerNode>();
    const teamNodes = new Map<string, TeamNode>();
    const rels: GraphRelationship[] = [];

    for (const file of repoFiles) {
      const matched = lastMatchingRule(file.relativePath, rules);
      if (!matched) continue;
      for (const handle of matched.rule.owners) {
        const { id, kind, isTeam } = classifyOwner(handle);
        if (isTeam) {
          if (!teamNodes.has(id)) {
            teamNodes.set(id, {
              id,
              label: 'Team',
              name: handle,
              properties: { name: handle, repoUrl },
            });
          }
        } else if (!ownerNodes.has(id)) {
          ownerNodes.set(id, {
            id,
            label: 'Owner',
            name: handle,
            properties: { identifier: handle, kind, repoUrl },
          });
        }
        rels.push({
          type: 'OWNED_BY',
          sourceId: file.fileId,
          targetId: id,
          confidence: 'HIGH',
          properties: { source: 'CODEOWNERS', pattern: matched.rule.pattern },
        });
      }
    }

    return {
      owners: [...ownerNodes.values()],
      teams: [...teamNodes.values()],
      relationships: rels,
    };
  }
}

interface OwnerClassification {
  readonly id: string;
  readonly kind: OwnerKind;
  readonly isTeam: boolean;
}

function classifyOwner(handle: string): OwnerClassification {
  if (handle.startsWith('@') && handle.includes('/')) {
    return { id: `team:${handle.slice(1).toLowerCase()}`, kind: 'team', isTeam: true };
  }
  if (handle.startsWith('@')) {
    return { id: `owner:${handle.slice(1).toLowerCase()}`, kind: 'user', isTeam: false };
  }
  // Plain email.
  return { id: `owner:${handle.toLowerCase()}`, kind: 'email', isTeam: false };
}

interface MatchedRule {
  readonly rule: CodeOwnerRule;
}

function lastMatchingRule(
  relativePath: string,
  rules: readonly CodeOwnerRule[],
): MatchedRule | undefined {
  let last: MatchedRule | undefined;
  for (const rule of rules) {
    if (matchesPattern(relativePath, rule.pattern)) {
      last = { rule };
    }
  }
  return last;
}

/**
 * CODEOWNERS glob matcher (subset of GitHub spec). Mirrors
 * `MetadataScanner.matchesPattern` so the two stay in lockstep, but kept
 * inline here so this extractor is a pure leaf and free of cross-package
 * private coupling.
 */
function matchesPattern(path: string, pattern: string): boolean {
  const p = path.replace(/^\/+/, '');
  if (pattern === '*') return true;

  if (pattern.endsWith('/')) {
    const dir = pattern.replace(/^\/+/, '');
    return p.startsWith(dir);
  }

  const isAnchored = pattern.startsWith('/');
  const pat = pattern.replace(/^\/+/, '');

  const regexBody = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLESTAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLESTAR::/g, '.*');

  const reFull = new RegExp('^' + regexBody + '$');
  if (isAnchored) return reFull.test(p);
  if (reFull.test(p)) return true;
  const last = p.split('/').pop() ?? '';
  return reFull.test(last);
}

/** Cast helpers used by the pipeline so OwnerNode / TeamNode flow into GraphNode arrays. */
export function asGraphNodes(
  result: CodeownersExtractionResult,
): readonly GraphNode[] {
  return [...result.owners, ...result.teams];
}
