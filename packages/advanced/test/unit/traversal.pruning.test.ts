import { describe, it, expect } from 'vitest';
import { prune, type Prunable } from '../../src/traversal.pruning.js';

describe('prune — service-boundary policy', () => {
  it('keeps low-fanout services first within a layer', () => {
    const rows: Prunable[] = [
      { id: 'a1', distance: 1, serviceName: 'big' },
      { id: 'a2', distance: 1, serviceName: 'big' },
      { id: 'a3', distance: 1, serviceName: 'big' },
      { id: 'a4', distance: 1, serviceName: 'rare' }, // singleton — should rank top
    ];
    const kept = prune(rows, { policy: 'service-boundary', maxNodesPerLayer: 2 });
    expect(kept).toHaveLength(2);
    expect(kept[0]?.id).toBe('a4');
  });

  it('preserves layer boundaries (distance buckets)', () => {
    const rows: Prunable[] = [
      { id: 'l1a', distance: 1, serviceName: 'x' },
      { id: 'l1b', distance: 1, serviceName: 'x' },
      { id: 'l2a', distance: 2, serviceName: 'y' },
    ];
    const kept = prune(rows, { policy: 'service-boundary', maxNodesPerLayer: 1 });
    // 1 from each layer.
    expect(kept).toHaveLength(2);
    expect(kept.map((k) => k.distance).sort()).toEqual([1, 2]);
  });
});

describe('prune — call-count policy', () => {
  it('prefers higher call-site counts', () => {
    const rows: Prunable[] = [
      { id: 'low', distance: 1, callSites: 1 },
      { id: 'high', distance: 1, callSites: 50 },
      { id: 'mid', distance: 1, callSites: 10 },
    ];
    const kept = prune(rows, { policy: 'call-count', maxNodesPerLayer: 2 });
    expect(kept.map((k) => k.id)).toEqual(['high', 'mid']);
  });

  it('treats missing callSites as 0', () => {
    const rows: Prunable[] = [
      { id: 'a', distance: 1 },
      { id: 'b', distance: 1, callSites: 5 },
    ];
    const kept = prune(rows, { policy: 'call-count', maxNodesPerLayer: 1 });
    expect(kept[0]?.id).toBe('b');
  });
});

describe('prune — ownership policy', () => {
  it('weights cross-service edges higher than same-service', () => {
    const rows: Prunable[] = [
      { id: 'same', distance: 1, serviceName: 'home' },
      { id: 'cross', distance: 1, serviceName: 'other' },
      { id: 'edge-cross', distance: 1, fromService: 'other' },
    ];
    const kept = prune(rows, { policy: 'ownership', maxNodesPerLayer: 2, anchorService: 'home' });
    // Cross-service nodes should rank above same-service.
    expect(kept[0]?.id).toBe('cross');
    // edge-cross beats same-service (score 1 vs 0).
    expect(kept[1]?.id).toBe('edge-cross');
  });

  it('returns 0-score noise when anchorService missing', () => {
    const rows: Prunable[] = [
      { id: 'a', distance: 1, serviceName: 'x' },
      { id: 'b', distance: 1, serviceName: 'y' },
    ];
    const kept = prune(rows, { policy: 'ownership', maxNodesPerLayer: 2 });
    expect(kept).toHaveLength(2);
  });
});

describe('prune — input edge cases', () => {
  it('returns empty for empty input', () => {
    expect(prune([])).toEqual([]);
  });

  it('clamps maxNodesPerLayer below 1 to 1', () => {
    const rows: Prunable[] = [
      { id: 'a', distance: 1, serviceName: 's' },
      { id: 'b', distance: 1, serviceName: 's' },
    ];
    const kept = prune(rows, { policy: 'service-boundary', maxNodesPerLayer: 0 });
    expect(kept).toHaveLength(1);
  });
});
