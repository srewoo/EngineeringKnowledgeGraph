import { describe, it, expect } from 'vitest';
import { DotenvExtractor } from '../../src/dotenv.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

const ENV_EXAMPLE = `
# Database
DATABASE_URL=postgres://localhost:5432/app
DATABASE_POOL_SIZE=10

# Auth (placeholder values — replace at deploy time)
JWT_SECRET=<change_me>
API_KEY=

# Misc
NODE_ENV=development
PORT="8080"

export EXPORTED_VAR=hello # inline comment
`.trim();

describe('DotenvExtractor', () => {
  const extractor = new DotenvExtractor();

  describe('handlesByPath', () => {
    it('accepts .env.example / .env.template / .env.sample', () => {
      expect(DotenvExtractor.handlesByPath('.env.example')).toBe(true);
      expect(DotenvExtractor.handlesByPath('.env.template')).toBe(true);
      expect(DotenvExtractor.handlesByPath('.env.sample')).toBe(true);
      expect(DotenvExtractor.handlesByPath('.env.production.example')).toBe(true);
    });

    it('rejects plain .env (would leak real secrets)', () => {
      expect(DotenvExtractor.handlesByPath('.env')).toBe(false);
      expect(DotenvExtractor.handlesByPath('apps/web/.env')).toBe(false);
    });
  });

  describe('extract', () => {
    it('parses KEY=value lines and skips comments and blanks', () => {
      const { configKeys } = extractor.extract(ENV_EXAMPLE, '.env.example', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toEqual([
        'DATABASE_URL', 'DATABASE_POOL_SIZE',
        'JWT_SECRET', 'API_KEY',
        'NODE_ENV', 'PORT',
        'EXPORTED_VAR',
      ]);
    });

    it('captures default values and strips quotes', () => {
      const { configKeys } = extractor.extract(ENV_EXAMPLE, '.env.example', REPO);
      const port = configKeys.find((k) => k.properties.key === 'PORT');
      expect(port?.properties.defaultValue).toBe('8080');
    });

    it('marks secret-like keys with placeholder/empty values as isSecret', () => {
      const { configKeys } = extractor.extract(ENV_EXAMPLE, '.env.example', REPO);
      const jwt = configKeys.find((k) => k.properties.key === 'JWT_SECRET');
      const apiKey = configKeys.find((k) => k.properties.key === 'API_KEY');
      const dbUrl = configKeys.find((k) => k.properties.key === 'DATABASE_URL');
      expect(jwt?.properties.isSecret).toBe(true);
      expect(apiKey?.properties.isSecret).toBe(true);
      expect(dbUrl?.properties.isSecret).toBe(false);
    });

    it('uses ENV kind and lifts envScope from filename', () => {
      const { configKeys } = extractor.extract('FOO=bar\n', '.env.production.example', REPO);
      expect(configKeys[0]?.properties.kind).toBe('ENV');
      expect(configKeys[0]?.properties.envScope).toBe('production');
    });

    it('records sourceLine 1-based', () => {
      const { configKeys } = extractor.extract('# header\nA=1\n\nB=2\n', '.env.example', REPO);
      const a = configKeys.find((k) => k.properties.key === 'A');
      const b = configKeys.find((k) => k.properties.key === 'B');
      expect(a?.properties.sourceLine).toBe(2);
      expect(b?.properties.sourceLine).toBe(4);
    });
  });
});
