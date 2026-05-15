/**
 * Configuration type definitions for ekg.config.json and environment.
 */

export interface RepoConfig {
  readonly url: string;
  readonly branch: string;
  readonly token?: string;
  readonly serviceMappings?: Readonly<Record<string, string>>;
}

export interface EkgConfig {
  readonly repos: readonly RepoConfig[];
  readonly ignoreDirs: readonly string[];
  readonly supportedExtensions: readonly string[];
}

export interface EnvConfig {
  readonly neo4jUri: string;
  readonly neo4jUser: string;
  readonly neo4jPassword: string;
  readonly gitToken?: string;
  readonly logLevel: string;
  readonly dataDir: string;
}
