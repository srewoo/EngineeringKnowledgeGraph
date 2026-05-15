import { describe, it, expect } from 'vitest';
import { HelmValuesExtractor } from '../../src/helm.values.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

const VALUES_YAML = `
image:
  repository: nginx
  tag: 1.25
replicaCount: 3
db:
  host: postgres.svc
  password: vault:secret/data/db#password
api:
  apiKey: \${secrets.API_KEY}
`.trim();

describe('HelmValuesExtractor', () => {
  const extractor = new HelmValuesExtractor();

  describe('handlesByPath', () => {
    it('matches values.yaml basename', () => {
      expect(HelmValuesExtractor.handlesByPath('charts/svc/values.yaml')).toBe(true);
      expect(HelmValuesExtractor.handlesByPath('helm/values.prod.yaml')).toBe(true);
    });

    it('matches yaml under /charts/ or /helm/', () => {
      expect(HelmValuesExtractor.handlesByPath('charts/foo/templates/_helpers.tpl.yaml')).toBe(true);
    });

    it('rejects unrelated yaml', () => {
      expect(HelmValuesExtractor.handlesByPath('config/app.yaml')).toBe(false);
    });
  });

  describe('envScopeFromFilename', () => {
    it('returns env from values.<env>.yaml', () => {
      expect(HelmValuesExtractor.envScopeFromFilename('charts/foo/values.prod.yaml')).toBe('prod');
    });

    it('returns default for plain values.yaml', () => {
      expect(HelmValuesExtractor.envScopeFromFilename('charts/foo/values.yaml')).toBe('default');
    });
  });

  describe('extract', () => {
    it('emits ConfigKey for each leaf and SecretRef for vault placeholders', () => {
      const { configKeys, secretRefs } = extractor.extract(VALUES_YAML, 'charts/svc/values.yaml', REPO);

      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('image.repository');
      expect(keys).toContain('image.tag');
      expect(keys).toContain('replicaCount');
      expect(keys).toContain('db.host');

      // password is a vault secret → SecretRef, not ConfigKey
      expect(keys).not.toContain('db.password');
      expect(secretRefs).toHaveLength(2);
      const refs = secretRefs.map((s) => s.properties.ref);
      expect(refs).toContain('vault:secret/data/db#password');
      expect(refs.some((r) => r.includes('${secrets.API_KEY}'))).toBe(true);
    });

    it('classifies vault references with VAULT vendor', () => {
      const { secretRefs } = extractor.extract(VALUES_YAML, 'charts/svc/values.yaml', REPO);
      const vault = secretRefs.find((s) => s.properties.ref.startsWith('vault:'));
      expect(vault?.properties.vendor).toBe('VAULT');
    });

    it('attaches envScope from values.<env>.yaml', () => {
      const yaml = 'foo: bar\n';
      const { configKeys } = extractor.extract(yaml, 'helm/values.prod.yaml', REPO);
      expect(configKeys[0]?.properties.envScope).toBe('prod');
      expect(configKeys[0]?.properties.kind).toBe('HELM');
    });

    it('returns empty for invalid yaml', () => {
      const r = extractor.extract('foo: [unterminated\n  - bar', 'helm/values.yaml', REPO);
      expect(r.configKeys).toHaveLength(0);
      expect(r.secretRefs).toHaveLength(0);
    });

    it('returns empty for scalar root (not an object)', () => {
      const r = extractor.extract('just-a-string', 'helm/values.yaml', REPO);
      expect(r.configKeys).toHaveLength(0);
    });
  });
});
