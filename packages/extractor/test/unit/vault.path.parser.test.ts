/**
 * Phase 1.6 follow-ups — VaultPathParser tests.
 */
import { describe, it, expect } from 'vitest';
import { VaultPathParser, vaultNodeId } from '../../src/vault.path.parser.js';

describe('VaultPathParser', () => {
  const parser = new VaultPathParser();

  it('parses Vault KV v2 ref → mountPath excludes #key', () => {
    const r = parser.parse('vault:secret/data/users#api_key', 'VAULT');
    expect(r.mountPath).toBe('secret/data/users');
    expect(r.key).toBe('api_key');
  });

  it('clusters multiple Vault keys under the same mountPath', () => {
    const a = parser.parse('vault:secret/data/users#api_key', 'VAULT');
    const b = parser.parse('vault:secret/data/users#refresh_token', 'VAULT');
    expect(a.mountPath).toBe(b.mountPath);
    expect(vaultNodeId(a.vendor, a.mountPath!)).toBe(vaultNodeId(b.vendor, b.mountPath!));
  });

  it('parses Vault KV v1 ref (kv/<mount>)', () => {
    const r = parser.parse('vault:kv/data/payments#token', 'VAULT');
    expect(r.mountPath).toBe('kv/data/payments');
    expect(r.key).toBe('token');
  });

  it('parses Vault KV v2 nested mount paths', () => {
    const r = parser.parse('vault:secret/data/team-a/db#password', 'VAULT');
    expect(r.mountPath).toBe('secret/data/team-a/db');
  });

  it('parses an AWS Secrets Manager ARN with a key suffix', () => {
    const ref = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:db-creds-AbCdEf:password';
    const r = parser.parse(ref, 'AWS_SM');
    expect(r.mountPath).toBe('arn:aws:secretsmanager:us-east-1:111122223333:secret:db-creds-AbCdEf');
    expect(r.key).toBe('password');
  });

  it('parses a key-less AWS Secrets Manager ARN', () => {
    const ref = 'arn:aws:secretsmanager:us-east-1:111122223333:secret:db-creds-AbCdEf';
    const r = parser.parse(ref, 'AWS_SM');
    expect(r.mountPath).toBe(ref);
    expect(r.key).toBeUndefined();
  });

  it('parses an AWS SSM parameter ARN', () => {
    const ref = 'arn:aws:ssm:us-west-2:111122223333:parameter/app/prod/db_url';
    const r = parser.parse(ref, 'AWS_PARAMS');
    expect(r.mountPath).toBe(ref);
  });

  it('parses a GCP Secret Manager path → strips /versions/<v>', () => {
    const r = parser.parse('projects/my-proj/secrets/api-key/versions/3', 'GCP_SECRETS');
    expect(r.mountPath).toBe('projects/my-proj/secrets/api-key');
    expect(r.key).toBe('value');
  });

  it('parses an Azure Key Vault URL → strips trailing version', () => {
    const r = parser.parse('https://my-vault.vault.azure.net/secrets/db-pwd/abc123', 'AZURE_KV');
    expect(r.mountPath).toBe('my-vault.vault.azure.net/secrets/db-pwd');
  });

  it('parses a K8s Secret with namespace + key', () => {
    const r = parser.parse('kube-system/dockercfg#password', 'K8S_SECRET');
    expect(r.mountPath).toBe('k8s/kube-system/dockercfg');
    expect(r.key).toBe('password');
  });

  it('parses a K8s Secret with default namespace', () => {
    const r = parser.parse('my-secret#API_KEY', 'K8S_SECRET');
    expect(r.mountPath).toBe('k8s/default/my-secret');
    expect(r.key).toBe('API_KEY');
  });

  it('returns undefined mountPath for UNKNOWN vendor', () => {
    const r = parser.parse('something-weird', 'UNKNOWN');
    expect(r.mountPath).toBeUndefined();
  });

  it('returns undefined mountPath for malformed Vault ref', () => {
    const r = parser.parse('not-a-vault-ref', 'VAULT');
    expect(r.mountPath).toBeUndefined();
  });

  it('vaultNodeId is deterministic and includes vendor', () => {
    expect(vaultNodeId('VAULT', 'secret/data/x')).toBe('vault:VAULT:secret/data/x');
    expect(vaultNodeId('AWS_SM', 'arn:foo')).toBe('vault:AWS_SM:arn:foo');
  });
});
