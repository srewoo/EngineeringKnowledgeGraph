/**
 * Pure-derivation tests for DataLineagePass. No Neo4j, no I/O.
 * Validates that EXPOSES_DATA edges are emitted iff:
 *   - the API has a parseable schema with non-generic field names
 *   - the API is EXPOSED by a Service that OWNs the column's Table
 *   - the column name (after normalisation) matches a schema field
 *   - the column is not a generic name (`id`, `created_at`, ...)
 */

import { describe, it, expect } from 'vitest';
import { DataLineagePass, __internals } from '../../src/data.lineage.pass.js';
import type { GraphNode, GraphRelationship } from '@ekg/shared';

const SVC: GraphNode = {
  id: 'Service:billing',
  label: 'Service',
  name: 'billing',
  properties: { name: 'billing', repoUrl: 'r', directory: 'apps/billing' },
};

function api(id: string, requestSchema: unknown, responseSchemas: unknown): GraphNode {
  return {
    id,
    label: 'API',
    name: id,
    properties: {
      method: 'POST',
      path: '/v1/things',
      framework: 'express',
      requestSchema: typeof requestSchema === 'string' ? requestSchema : JSON.stringify(requestSchema),
      responseSchemas: typeof responseSchemas === 'string' ? responseSchemas : JSON.stringify(responseSchemas),
    },
  };
}

function tableNode(id: string, name: string): GraphNode {
  return { id, label: 'Table', name, properties: { name } };
}

function col(id: string, name: string, tableId: string): GraphNode {
  return {
    id, label: 'Column', name,
    properties: {
      tableId, name, type: 'text', nullable: false, isPrimary: false, isUnique: false,
    },
  };
}

const exposes = (s: string, a: string): GraphRelationship => ({ type: 'EXPOSES', sourceId: s, targetId: a, confidence: 'HIGH', properties: {} });
const owns    = (s: string, t: string): GraphRelationship => ({ type: 'OWNS',    sourceId: s, targetId: t, confidence: 'HIGH', properties: {} });
const has     = (t: string, c: string): GraphRelationship => ({ type: 'HAS',     sourceId: t, targetId: c, confidence: 'HIGH', properties: {} });

describe('DataLineagePass.run', () => {
  it('emits EXPOSES_DATA for camelCase API field matching snake_case column', () => {
    const pass = new DataLineagePass();
    const a = api('API:POST /v1/users', { properties: { userEmail: { type: 'string' } } }, {});
    const t = tableNode('Table:users', 'users');
    const c = col('Column:users.user_email', 'user_email', t.id);
    const result = pass.run({
      nodes: [SVC, a, t, c],
      relationships: [exposes(SVC.id, a.id), owns(SVC.id, t.id), has(t.id, c.id)],
    });
    expect(result.newRelationships).toHaveLength(1);
    expect(result.newRelationships[0]!.type).toBe('EXPOSES_DATA');
    expect(result.newRelationships[0]!.sourceId).toBe(a.id);
    expect(result.newRelationships[0]!.targetId).toBe(c.id);
    expect(result.newRelationships[0]!.confidence).toBe('HIGH');
  });

  it('skips generic column names (id, created_at, ...)', () => {
    const pass = new DataLineagePass();
    const a = api('API:GET /v1/things/:id', { properties: { id: { type: 'string' } } }, {});
    const t = tableNode('Table:things', 'things');
    const c = col('Column:things.id', 'id', t.id);
    const result = pass.run({
      nodes: [SVC, a, t, c],
      relationships: [exposes(SVC.id, a.id), owns(SVC.id, t.id), has(t.id, c.id)],
    });
    expect(result.newRelationships).toHaveLength(0);
  });

  it('does not cross service boundaries (no link when no OWNs path)', () => {
    const pass = new DataLineagePass();
    const a = api('API:POST /v1/users', { properties: { customerEmail: { type: 'string' } } }, {});
    const t = tableNode('Table:other_service_table', 'profiles');
    const c = col('Column:profiles.customer_email', 'customer_email', t.id);
    const result = pass.run({
      nodes: [SVC, a, t, c],
      // Service EXPOSES the API but does NOT own the table — must not emit edge.
      relationships: [exposes(SVC.id, a.id), has(t.id, c.id)],
    });
    expect(result.newRelationships).toHaveLength(0);
    expect(result.stats.apisWithoutService).toBe(0);
  });

  it('handles response schemas (Record<status, schema>) as well as request', () => {
    const pass = new DataLineagePass();
    const a = api('API:GET /v1/users', {}, {
      '200': { properties: { fullName: { type: 'string' } } },
    });
    const t = tableNode('Table:users', 'users');
    const c = col('Column:users.full_name', 'full_name', t.id);
    const result = pass.run({
      nodes: [SVC, a, t, c],
      relationships: [exposes(SVC.id, a.id), owns(SVC.id, t.id), has(t.id, c.id)],
    });
    expect(result.newRelationships).toHaveLength(1);
    expect(result.newRelationships[0]!.confidence).toBe('HIGH');
  });

  it('falls back to MEDIUM-confidence suffix match', () => {
    const pass = new DataLineagePass();
    // API field is `customerEmail`; column is just `email` (not generic-listed).
    const a = api('API:POST /v1/x', { properties: { customerEmail: { type: 'string' } } }, {});
    const t = tableNode('Table:customers', 'customers');
    const c = col('Column:customers.email', 'email', t.id);
    const result = pass.run({
      nodes: [SVC, a, t, c],
      relationships: [exposes(SVC.id, a.id), owns(SVC.id, t.id), has(t.id, c.id)],
    });
    expect(result.newRelationships).toHaveLength(1);
    const edge = result.newRelationships[0]!;
    expect(edge.confidence).toBe('MEDIUM');
    expect((edge.properties as { matchKind: string }).matchKind).toBe('suffix');
  });

  it('counts APIs without schema vs without service', () => {
    const pass = new DataLineagePass();
    const aNoSchema = api('API:GET /noop', {}, {});
    const aNoSvc = api('API:POST /orphan', { properties: { thing: {} } }, {});
    const result = pass.run({
      nodes: [SVC, aNoSchema, aNoSvc, col('Column:c', 'thing', 'Table:t')],
      relationships: [], // neither EXPOSES nor OWNS
    });
    expect(result.stats.apisWithoutSchema).toBe(1);    // aNoSchema
    expect(result.stats.apisWithoutService).toBe(1);   // aNoSvc — has schema but no service
  });
});

describe('DataLineagePass.__internals.normalize', () => {
  it('camelCase → snake_case', () => {
    expect(__internals.normalize('userEmail')).toBe('user_email');
    expect(__internals.normalize('orgId')).toBe('org_id');
    expect(__internals.normalize('XMLHttpRequest')).toBe('xmlhttp_request');
  });
  it('handles hyphens and spaces', () => {
    expect(__internals.normalize('first-name')).toBe('first_name');
    expect(__internals.normalize('first name')).toBe('first_name');
  });
});
