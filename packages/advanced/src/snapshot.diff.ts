/**
 * Pure diff between two SnapshotPayloads.
 *
 * "Changed" edges are pairs that exist in both snapshots but with a different
 * set of edge kinds (e.g. added a new PRODUCES on top of an existing CALLS_API).
 */

import type { SnapshotEdge, SnapshotPayload, SnapshotService } from './snapshot.builder.js';

export interface SnapshotDiff {
  readonly addedServices: readonly SnapshotService[];
  readonly removedServices: readonly SnapshotService[];
  readonly addedEdges: readonly SnapshotEdge[];
  readonly removedEdges: readonly SnapshotEdge[];
  readonly changedEdges: readonly ChangedEdge[];
  readonly summary: DiffSummary;
}

export interface ChangedEdge {
  readonly from: string;
  readonly to: string;
  readonly before: Readonly<Record<string, number>>;
  readonly after: Readonly<Record<string, number>>;
}

export interface DiffSummary {
  readonly addedServiceCount: number;
  readonly removedServiceCount: number;
  readonly addedEdgeCount: number;
  readonly removedEdgeCount: number;
  readonly changedEdgeCount: number;
  readonly capturedFrom: string;
  readonly capturedTo: string;
}

export function diff(prev: SnapshotPayload, curr: SnapshotPayload): SnapshotDiff {
  const prevServices = indexServices(prev.services);
  const currServices = indexServices(curr.services);

  const addedServices: SnapshotService[] = [];
  const removedServices: SnapshotService[] = [];

  for (const [name, svc] of currServices) {
    if (!prevServices.has(name)) addedServices.push(svc);
  }
  for (const [name, svc] of prevServices) {
    if (!currServices.has(name)) removedServices.push(svc);
  }

  const prevEdges = indexEdges(prev.edges);
  const currEdges = indexEdges(curr.edges);

  const addedEdges: SnapshotEdge[] = [];
  const removedEdges: SnapshotEdge[] = [];
  const changedEdges: ChangedEdge[] = [];

  for (const [k, e] of currEdges) {
    const prior = prevEdges.get(k);
    if (!prior) addedEdges.push(e);
    else if (!sameKinds(prior.kinds, e.kinds)) {
      changedEdges.push({ from: e.from, to: e.to, before: prior.kinds, after: e.kinds });
    }
  }
  for (const [k, e] of prevEdges) {
    if (!currEdges.has(k)) removedEdges.push(e);
  }

  return {
    addedServices: addedServices.sort(byServiceName),
    removedServices: removedServices.sort(byServiceName),
    addedEdges: addedEdges.sort(byEdge),
    removedEdges: removedEdges.sort(byEdge),
    changedEdges: changedEdges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)),
    summary: {
      addedServiceCount: addedServices.length,
      removedServiceCount: removedServices.length,
      addedEdgeCount: addedEdges.length,
      removedEdgeCount: removedEdges.length,
      changedEdgeCount: changedEdges.length,
      capturedFrom: prev.capturedAt,
      capturedTo: curr.capturedAt,
    },
  };
}

function indexServices(svcs: readonly SnapshotService[]): Map<string, SnapshotService> {
  const m = new Map<string, SnapshotService>();
  for (const s of svcs) {
    if (!s.name) continue;
    m.set(s.name, s);
  }
  return m;
}

function indexEdges(edges: readonly SnapshotEdge[]): Map<string, SnapshotEdge> {
  const m = new Map<string, SnapshotEdge>();
  for (const e of edges) m.set(`${e.from}->${e.to}`, e);
  return m;
}

function sameKinds(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}

function byServiceName(a: SnapshotService, b: SnapshotService): number {
  return a.name.localeCompare(b.name);
}

function byEdge(a: SnapshotEdge, b: SnapshotEdge): number {
  return a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
}
