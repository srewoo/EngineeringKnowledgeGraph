import { describe, it, expect } from 'vitest';
import { K8sManifestExtractor } from '../../src/k8s.manifest.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

const MULTI_DOC = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: api-config
data:
  LOG_LEVEL: info
  FEATURE_X: "true"
---
apiVersion: v1
kind: Secret
metadata:
  name: api-secrets
stringData:
  API_KEY: placeholder
  DB_PASSWORD: placeholder
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  template:
    spec:
      containers:
        - name: api
          env:
            - name: PORT
              value: "8080"
            - name: DATABASE_URL
              valueFrom:
                secretKeyRef:
                  name: api-secrets
                  key: DB_PASSWORD
          envFrom:
            - configMapRef:
                name: api-config
            - secretRef:
                name: api-secrets
`.trim();

describe('K8sManifestExtractor', () => {
  const extractor = new K8sManifestExtractor();

  describe('handlesByPath', () => {
    it('matches yaml under /k8s/ /manifests/ /deploy/', () => {
      expect(K8sManifestExtractor.handlesByPath('k8s/deploy.yaml')).toBe(true);
      expect(K8sManifestExtractor.handlesByPath('manifests/cm.yml')).toBe(true);
      expect(K8sManifestExtractor.handlesByPath('deploy/api.yaml')).toBe(true);
    });

    it('rejects yaml elsewhere', () => {
      expect(K8sManifestExtractor.handlesByPath('config/app.yaml')).toBe(false);
    });
  });

  describe('sniff', () => {
    it('detects manifests by apiVersion + kind keys', () => {
      expect(K8sManifestExtractor.sniff('apiVersion: v1\nkind: Pod\n')).toBe(true);
    });

    it('returns false otherwise', () => {
      expect(K8sManifestExtractor.sniff('foo: bar')).toBe(false);
    });
  });

  describe('extract', () => {
    it('emits ConfigMap data entries as ConfigKey nodes', () => {
      const { configKeys } = extractor.extract(MULTI_DOC, 'k8s/deploy.yaml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('api-config.LOG_LEVEL');
      expect(keys).toContain('api-config.FEATURE_X');
    });

    it('emits Secret data entries as SecretRef with K8S_SECRET vendor', () => {
      const { secretRefs } = extractor.extract(MULTI_DOC, 'k8s/deploy.yaml', REPO);
      const refs = secretRefs.map((s) => s.properties.ref);
      expect(refs).toContain('k8s:api-secrets#API_KEY');
      expect(refs).toContain('k8s:api-secrets#DB_PASSWORD');
      // valueFrom.secretKeyRef
      expect(refs).toContain('k8s:api-secrets#DB_PASSWORD');
      // envFrom.secretRef → wildcard
      expect(refs).toContain('k8s:api-secrets#*');
      for (const sr of secretRefs) {
        expect(sr.properties.vendor).toBe('K8S_SECRET');
      }
    });

    it('emits container env entries as ConfigKey', () => {
      const { configKeys } = extractor.extract(MULTI_DOC, 'k8s/deploy.yaml', REPO);
      const port = configKeys.find((k) => k.properties.key === 'PORT');
      expect(port).toBeDefined();
      expect(port!.properties.defaultValue).toBe('8080');
      expect(port!.properties.kind).toBe('K8S');
    });

    it('emits envFrom configMapRef as wildcard ConfigKey', () => {
      const { configKeys } = extractor.extract(MULTI_DOC, 'k8s/deploy.yaml', REPO);
      const wildcard = configKeys.find((k) => k.properties.key === 'api-config.*');
      expect(wildcard).toBeDefined();
    });

    it('returns empty for non-manifest yaml', () => {
      const r = extractor.extract('foo: bar\n', 'k8s/deploy.yaml', REPO);
      expect(r.configKeys).toHaveLength(0);
      expect(r.secretRefs).toHaveLength(0);
    });
  });
});
