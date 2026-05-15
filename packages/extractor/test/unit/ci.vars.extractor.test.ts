import { describe, it, expect } from 'vitest';
import { CiVarsExtractor } from '../../src/ci.vars.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

const GITHUB_WORKFLOW = `
name: build
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    env:
      LOG_LEVEL: info
    steps:
      - uses: actions/checkout@v4
      - name: Test
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          DATABASE_URL: \${{ vars.DATABASE_URL }}
        run: |
          echo "deploy with \${{ secrets.DEPLOY_KEY }}"
`.trim();

const GITLAB_CI = `
variables:
  IMAGE_TAG: latest
  DEPLOY_ENV: staging
build:
  stage: build
  script:
    - echo "$CI_PROJECT_NAME"
    - echo "$DATABASE_URL"
    - aws --region us-east-1 deploy
deploy:
  variables:
    EXTRA_FLAG: "true"
  script:
    - ./deploy.sh "$DEPLOY_ENV"
`.trim();

describe('CiVarsExtractor', () => {
  const extractor = new CiVarsExtractor();

  describe('handlesByPath', () => {
    it('matches GitHub workflow files', () => {
      expect(CiVarsExtractor.handlesByPath('.github/workflows/ci.yml')).toBe(true);
    });

    it('matches GitLab CI files', () => {
      expect(CiVarsExtractor.handlesByPath('.gitlab-ci.yml')).toBe(true);
      expect(CiVarsExtractor.handlesByPath('.gitlab/ci/build.yml')).toBe(true);
    });

    it('rejects unrelated yaml', () => {
      expect(CiVarsExtractor.handlesByPath('config/app.yaml')).toBe(false);
    });
  });

  describe('GitHub Actions extraction', () => {
    it('captures secrets.X references as SecretRef', () => {
      const { secretRefs } = extractor.extract(GITHUB_WORKFLOW, '.github/workflows/ci.yml', REPO);
      const refs = secretRefs.map((s) => s.properties.ref);
      expect(refs).toContain('github:secret/GITHUB_TOKEN');
      expect(refs).toContain('github:secret/DEPLOY_KEY');
      for (const sr of secretRefs) {
        expect(sr.properties.vendor).toBe('UNKNOWN');
      }
    });

    it('captures vars.X references as ConfigKey', () => {
      const { configKeys } = extractor.extract(GITHUB_WORKFLOW, '.github/workflows/ci.yml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('DATABASE_URL');
    });

    it('does not capture bare env: blocks (only declared variables)', () => {
      const { configKeys } = extractor.extract(GITHUB_WORKFLOW, '.github/workflows/ci.yml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      // `env:` is a runtime injection, not a declared variable, so we
      // intentionally skip it. Captured values arrive via secrets./vars.
      expect(keys).not.toContain('LOG_LEVEL');
    });
  });

  describe('GitLab CI extraction', () => {
    it('captures variables: block as ConfigKey', () => {
      const { configKeys } = extractor.extract(GITLAB_CI, '.gitlab-ci.yml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('IMAGE_TAG');
      expect(keys).toContain('DEPLOY_ENV');
      expect(keys).toContain('EXTRA_FLAG');
      const imageTag = configKeys.find((k) => k.properties.key === 'IMAGE_TAG');
      expect(imageTag?.properties.defaultValue).toBe('latest');
      expect(imageTag?.properties.kind).toBe('CI');
    });

    it('captures shell-style $VAR references for CI_* and secret-like names', () => {
      const { configKeys } = extractor.extract(GITLAB_CI, '.gitlab-ci.yml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('CI_PROJECT_NAME');
    });
  });
});
