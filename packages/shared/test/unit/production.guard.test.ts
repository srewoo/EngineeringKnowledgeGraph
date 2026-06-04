/**
 * Tests for the production-config guard (Phase 1 of ADR-006 bridge).
 *
 * Local mode is a no-op. Hosted mode refuses:
 *   - known dev passwords
 *   - default 'local' tenantId
 *   - localhost Neo4j URI
 *   - bolt:// over non-loopback hosts (unless explicitly allowed)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  validateProductionConfig,
  validateProductionConfigOrThrow,
} from '../../src/production.guard.js';

const HOSTED_DEFAULTS = {
  deploymentMode: 'hosted' as const,
  neo4jUri: 'bolt+s://prod.example.com:7687',
  neo4jPassword: 'a-strong-password-with-entropy-9f3a2c',
  tenantId: 'acme-corp',
};

describe('validateProductionConfig — local mode', () => {
  it('is a no-op in local mode (passes with dev password)', () => {
    const r = validateProductionConfig({
      deploymentMode: 'local',
      neo4jUri: 'bolt://localhost:7687',
      neo4jPassword: 'ekg-local-dev',
      tenantId: 'local',
    });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('local');
    expect(r.violations).toEqual([]);
  });
});

describe('validateProductionConfig — hosted mode', () => {
  let savedEnv: string | undefined;
  beforeEach(() => { savedEnv = process.env['EKG_ALLOW_INSECURE_NEO4J']; delete process.env['EKG_ALLOW_INSECURE_NEO4J']; });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env['EKG_ALLOW_INSECURE_NEO4J'];
    else process.env['EKG_ALLOW_INSECURE_NEO4J'] = savedEnv;
  });

  it('passes with a strong password, non-localhost URI, custom tenant', () => {
    const r = validateProductionConfig(HOSTED_DEFAULTS);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it('refuses dev passwords (case-insensitive)', () => {
    const r = validateProductionConfig({ ...HOSTED_DEFAULTS, neo4jPassword: 'EKG-Local-Dev' });
    expect(r.ok).toBe(false);
    expect(r.violations.find((v) => v.rule === 'forbidden_password')).toBeDefined();
  });

  it('refuses the default local tenantId', () => {
    const r = validateProductionConfig({ ...HOSTED_DEFAULTS, tenantId: 'local' });
    expect(r.ok).toBe(false);
    expect(r.violations.find((v) => v.rule === 'default_tenant_in_hosted')).toBeDefined();
  });

  it('refuses localhost neo4j URIs (localhost / 127.0.0.1 / ::1)', () => {
    for (const uri of ['bolt://localhost:7687', 'bolt+s://127.0.0.1:7687', 'neo4j+s://[::1]:7687']) {
      const r = validateProductionConfig({ ...HOSTED_DEFAULTS, neo4jUri: uri });
      expect(r.violations.find((v) => v.rule === 'localhost_in_hosted')).toBeDefined();
    }
  });

  it('refuses bolt:// over public hosts by default', () => {
    const r = validateProductionConfig({ ...HOSTED_DEFAULTS, neo4jUri: 'bolt://prod.example.com:7687' });
    expect(r.violations.find((v) => v.rule === 'insecure_transport')).toBeDefined();
  });

  it('allows bolt:// over public hosts when EKG_ALLOW_INSECURE_NEO4J=true', () => {
    process.env['EKG_ALLOW_INSECURE_NEO4J'] = 'true';
    const r = validateProductionConfig({ ...HOSTED_DEFAULTS, neo4jUri: 'bolt://internal.vpn:7687' });
    expect(r.violations.find((v) => v.rule === 'insecure_transport')).toBeUndefined();
    expect(r.ok).toBe(true);
  });

  it('aggregates all violations rather than short-circuiting', () => {
    const r = validateProductionConfig({
      deploymentMode: 'hosted',
      neo4jUri: 'bolt://localhost:7687',
      neo4jPassword: 'password',
      tenantId: 'local',
    });
    // 3 violations: dev password + default tenant + localhost URI
    expect(r.violations.length).toBe(3);
    expect(new Set(r.violations.map((v) => v.rule))).toEqual(
      new Set(['forbidden_password', 'default_tenant_in_hosted', 'localhost_in_hosted']),
    );
  });
});

describe('validateProductionConfigOrThrow', () => {
  it('does not throw when ok', () => {
    expect(() => validateProductionConfigOrThrow({
      deploymentMode: 'local',
      neo4jUri: 'bolt://localhost:7687',
      neo4jPassword: 'ekg-local-dev',
      tenantId: 'local',
    })).not.toThrow();
  });
  it('throws a multi-line error summarising violations', () => {
    expect(() => validateProductionConfigOrThrow({
      deploymentMode: 'hosted',
      neo4jUri: 'bolt://localhost:7687',
      neo4jPassword: 'neo4j',
      tenantId: 'local',
    })).toThrow(/Production config check failed/);
  });
});
