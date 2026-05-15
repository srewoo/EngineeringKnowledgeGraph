/**
 * Pure Mermaid sequence-diagram renderer for FlowGraph.
 *
 * Caps actors and messages so the rendered diagram stays readable in chat
 * UIs that have hard message limits.
 */

import type { FlowGraph, FlowEdge, FlowNode } from './flow.synthesis.js';

export const MAX_ACTORS = 30;
export const MAX_MESSAGES = 80;

export interface RenderOptions {
  readonly maxActors?: number;
  readonly maxMessages?: number;
  readonly title?: string;
}

export function renderSequenceDiagram(flow: FlowGraph, opts: RenderOptions = {}): string {
  const maxActors = clampPositive(opts.maxActors ?? MAX_ACTORS, MAX_ACTORS);
  const maxMessages = clampPositive(opts.maxMessages ?? MAX_MESSAGES, MAX_MESSAGES);
  const lines: string[] = [];
  lines.push('sequenceDiagram');
  if (opts.title) lines.push(`  title ${escapeText(opts.title)}`);

  const actorOrder = orderActors(flow.nodes, flow.edges, maxActors);
  const actorIds = new Set(actorOrder.map((a) => a.id));
  for (const a of actorOrder) {
    lines.push(`  participant ${actorAlias(a)} as ${escapeText(actorLabel(a))}`);
  }

  const aliasFor = new Map(actorOrder.map((a) => [a.id, actorAlias(a)] as const));
  let drawn = 0;
  for (const e of flow.edges) {
    if (drawn >= maxMessages) break;
    if (!actorIds.has(e.from) || !actorIds.has(e.to)) continue;
    const fa = aliasFor.get(e.from);
    const ta = aliasFor.get(e.to);
    if (!fa || !ta) continue;
    lines.push(`  ${fa}->>${ta}: ${escapeText(e.type)}`);
    drawn++;
  }

  if (
    flow.edges.length > drawn ||
    flow.nodes.length > actorOrder.length ||
    flow.truncated
  ) {
    lines.push(`  Note over ${actorOrder[0]?.id ? actorAlias(actorOrder[0]) : 'A0'}: truncated — ${flow.nodes.length - actorOrder.length} actor(s) and ${flow.edges.length - drawn} message(s) hidden`);
  }
  return lines.join('\n');
}

function orderActors(
  nodes: readonly FlowNode[],
  edges: readonly FlowEdge[],
  cap: number,
): readonly FlowNode[] {
  // Preserve insertion order of nodes as discovered, then trim to cap.
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const seen = new Set<string>();
  const ordered: FlowNode[] = [];
  for (const e of edges) {
    for (const id of [e.from, e.to]) {
      if (seen.has(id)) continue;
      const node = byId.get(id);
      if (!node) continue;
      seen.add(id);
      ordered.push(node);
      if (ordered.length >= cap) return ordered;
    }
  }
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    ordered.push(n);
    if (ordered.length >= cap) break;
  }
  return ordered;
}

function actorAlias(node: FlowNode): string {
  // Mermaid participant ids must not contain spaces or special chars.
  const raw = `${node.label}_${node.name || node.id}`;
  return raw.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 40) || 'N';
}

function actorLabel(node: FlowNode): string {
  const name = node.name || node.id;
  return node.label ? `${node.label}:${name}` : name;
}

function escapeText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[;]/g, ',').slice(0, 120);
}

function clampPositive(n: number, hard: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), hard);
}
