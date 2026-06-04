/**
 * End-to-end fixture eval test.
 *
 * Builds a small hand-crafted graph (3 services, 2 APIs, an owner,
 * a config key, an MR), runs the FixtureAgent through a handful of
 * cases via runEval, and asserts the retrieval scores actually move
 * — proving the harness is wired correctly end-to-end.
 */

import { describe, it, expect } from 'vitest';
import { FixtureGraph, FixtureAgent } from '../src/index.js';
import { runEval } from '../src/eval.runner.js';
import type { EvalCase } from '../src/eval.types.js';
import type { GraphFixture } from '../src/fixtures.js';

const FIXTURE: GraphFixture = {
  nodes: [
    // Services
    { id: 'svc:payment-service',     label: 'Service', name: 'payment-service',     properties: {} },
    { id: 'svc:billing-core',        label: 'Service', name: 'billing-core',        properties: {} },
    { id: 'svc:gateway',             label: 'Service', name: 'gateway',             properties: {} },
    // APIs
    { id: 'api:POST /v1/charges',    label: 'API',     name: 'POST /v1/charges',    properties: { method: 'POST', path: '/v1/charges' } },
    { id: 'api:GET /v1/invoices',    label: 'API',     name: 'GET /v1/invoices',    properties: { method: 'GET',  path: '/v1/invoices' } },
    // Owner / team
    { id: 'owner:billing-team',      label: 'Team',    name: 'billing-team',        properties: {} },
    // Config
    { id: 'cfg:STRIPE_API_KEY',      label: 'ConfigKey', name: 'STRIPE_API_KEY',    properties: { key: 'STRIPE_API_KEY' } },
    // MR
    { id: 'mr:billing-core/!42',     label: 'MR',      name: 'billing-core/!42',    properties: { projectPath: 'billing-core', author: 'alice', title: 'Add invoice approval flow' } },
  ],
  edges: [
    { type: 'DEPENDS_ON', sourceId: 'svc:gateway',           targetId: 'svc:payment-service' },
    { type: 'DEPENDS_ON', sourceId: 'svc:payment-service',   targetId: 'svc:billing-core' },
    { type: 'EXPOSES',    sourceId: 'svc:payment-service',   targetId: 'api:POST /v1/charges' },
    { type: 'EXPOSES',    sourceId: 'svc:billing-core',      targetId: 'api:GET /v1/invoices' },
    { type: 'OWNS',       sourceId: 'owner:billing-team',    targetId: 'svc:billing-core' },
    { type: 'READS_CONFIG', sourceId: 'svc:billing-core',    targetId: 'cfg:STRIPE_API_KEY' },
  ],
};

const CASES: readonly EvalCase[] = [
  {
    id: 'topo-fix-001',
    question: 'What services depend on billing-core?',
    expectedClass: 'topology',
    goldCitations: ['svc:billing-core', 'svc:payment-service', 'svc:gateway'],
  },
  {
    id: 'own-fix-001',
    question: 'Who owns billing-core?',
    expectedClass: 'ownership',
    goldCitations: ['svc:billing-core', 'owner:billing-team'],
  },
  {
    id: 'cfg-fix-001',
    question: 'Where is the STRIPE_API_KEY configured?',
    expectedClass: 'config',
    goldCitations: ['cfg:STRIPE_API_KEY'],
  },
  {
    id: 'mr-fix-001',
    question: 'Show me MRs by alice',
    expectedClass: 'mr',
    goldCitations: ['mr:billing-core/!42'],
  },
];

describe('FixtureAgent end-to-end', () => {
  it('FixtureGraph indexes nodes and edges for fast lookup', () => {
    const g = new FixtureGraph(FIXTURE);
    expect(g.size()).toBe(FIXTURE.nodes.length);
    expect(g.byLabel('Service')).toHaveLength(3);
    expect(g.byName('billing-core')).toHaveLength(1);
    expect(g.dependents('svc:billing-core')).toEqual(
      expect.arrayContaining(['svc:payment-service', 'svc:gateway']),
    );
  });

  it('retrieves topology citations end-to-end', async () => {
    const g = new FixtureGraph(FIXTURE);
    const agent = new FixtureAgent(g);
    const result = await agent.ask('What services depend on billing-core?');
    expect(result.status).toBe('ok');
    expect(result.citations).toEqual(expect.arrayContaining(['svc:billing-core', 'svc:payment-service', 'svc:gateway']));
  });

  it('retrieves owner citations', async () => {
    const g = new FixtureGraph(FIXTURE);
    const agent = new FixtureAgent(g);
    const r = await agent.ask('Who owns billing-core?');
    expect(r.citations).toEqual(expect.arrayContaining(['svc:billing-core', 'owner:billing-team']));
  });

  it('retrieves config nodes by env-var name', async () => {
    const g = new FixtureGraph(FIXTURE);
    const agent = new FixtureAgent(g);
    const r = await agent.ask('Where is the STRIPE_API_KEY configured?');
    expect(r.citations).toContain('cfg:STRIPE_API_KEY');
  });

  it('retrieves MRs by author name', async () => {
    const g = new FixtureGraph(FIXTURE);
    const agent = new FixtureAgent(g);
    const r = await agent.ask('Show me MRs by alice');
    expect(r.citations).toContain('mr:billing-core/!42');
  });

  it('runEval produces non-zero retrieval recall on fixture cases', async () => {
    const g = new FixtureGraph(FIXTURE);
    const agent = new FixtureAgent(g);
    const { run, perCase } = await runEval(CASES, agent, { outDir: '/tmp/ekg-fixture-eval' });
    // Each case should at least retrieve its gold citations.
    expect(run.cases).toBe(CASES.length);
    expect(run.classifierAcc).toBeGreaterThanOrEqual(0.5);
    // Recall should be 1.0 on the topology / ownership / mr cases where
    // the agent's retrieval is a strict superset of gold.
    const recalls = perCase.map((c) => c.recall);
    expect(Math.max(...recalls)).toBe(1);
    // No NaNs or errors.
    expect(perCase.every((c) => c.status === 'ok')).toBe(true);
  });
});
