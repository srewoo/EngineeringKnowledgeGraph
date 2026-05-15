import { describe, it, expect } from 'vitest';
import { AppConfigExtractor } from '../../src/app.config.extractor.js';

const REPO = 'https://gitlab.com/acme/svc';

const SPRING_YAML = `
spring:
  datasource:
    url: \${DATABASE_URL:jdbc:postgresql://localhost/app}
    username: \${DB_USER:app}
server:
  port: 8080
logging:
  level:
    root: INFO
`.trim();

const APPSETTINGS_JSON = JSON.stringify({
  Logging: { LogLevel: { Default: 'Information' } },
  ConnectionStrings: { Default: 'Server=localhost' },
  ApiKey: 'placeholder',
});

const SPRING_PROPS = `
# Comment
server.port=8080
spring.application.name=svc
db.password=changeme
`.trim();

describe('AppConfigExtractor', () => {
  const extractor = new AppConfigExtractor();

  describe('handlesByPath', () => {
    it('matches Spring application.yaml and profile variants', () => {
      expect(AppConfigExtractor.handlesByPath('src/main/resources/application.yaml')).toBe(true);
      expect(AppConfigExtractor.handlesByPath('src/main/resources/application-prod.yml')).toBe(true);
      expect(AppConfigExtractor.handlesByPath('src/main/resources/application.properties')).toBe(true);
    });

    it('matches .NET appsettings.json', () => {
      expect(AppConfigExtractor.handlesByPath('appsettings.json')).toBe(true);
      expect(AppConfigExtractor.handlesByPath('src/appsettings.Production.json')).toBe(true);
    });

    it('matches generic config.json', () => {
      expect(AppConfigExtractor.handlesByPath('config.json')).toBe(true);
      expect(AppConfigExtractor.handlesByPath('src/config/server.yaml')).toBe(true);
    });
  });

  describe('Spring YAML extraction', () => {
    it('flattens nested keys to dot-paths', () => {
      const { configKeys } = extractor.extract(SPRING_YAML, 'application.yaml', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('spring.datasource.url');
      expect(keys).toContain('server.port');
      expect(keys).toContain('logging.level.root');
    });

    it('emits sibling ENV ConfigKey nodes for ${VAR:default} placeholders', () => {
      const { configKeys } = extractor.extract(SPRING_YAML, 'application.yaml', REPO);
      const envVars = configKeys.filter((k) => k.properties.kind === 'ENV');
      const names = envVars.map((k) => k.properties.key);
      expect(names).toContain('DATABASE_URL');
      expect(names).toContain('DB_USER');
    });

    it('lifts envScope from application-<env>.yml', () => {
      const { configKeys } = extractor.extract('foo: bar\n', 'application-prod.yml', REPO);
      expect(configKeys[0]?.properties.envScope).toBe('prod');
    });
  });

  describe('.NET appsettings.json extraction', () => {
    it('emits ConfigKey for nested JSON paths', () => {
      const { configKeys } = extractor.extract(APPSETTINGS_JSON, 'appsettings.json', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('Logging.LogLevel.Default');
      expect(keys).toContain('ConnectionStrings.Default');
      expect(keys).toContain('ApiKey');
    });

    it('flags ApiKey as isSecret by name heuristic', () => {
      const { configKeys } = extractor.extract(APPSETTINGS_JSON, 'appsettings.json', REPO);
      const apiKey = configKeys.find((k) => k.properties.key === 'ApiKey');
      expect(apiKey?.properties.isSecret).toBe(true);
    });
  });

  describe('Spring .properties extraction', () => {
    it('parses key=value lines with line numbers', () => {
      const { configKeys } = extractor.extract(SPRING_PROPS, 'application.properties', REPO);
      const keys = configKeys.map((k) => k.properties.key);
      expect(keys).toContain('server.port');
      expect(keys).toContain('spring.application.name');
      expect(keys).toContain('db.password');
      const port = configKeys.find((k) => k.properties.key === 'server.port');
      expect(port?.properties.defaultValue).toBe('8080');
    });
  });
});
