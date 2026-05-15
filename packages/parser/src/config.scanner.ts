/**
 * Config file scanner — extracts database connection strings and settings.
 *
 * Parses:
 * - `.env` files for DB URLs and connection parameters
 * - `config/*.json` and `config/*.yaml` for database settings
 * - `docker-compose.yml` for service/database definitions
 *
 * This complements the AST-based parser by catching database usage
 * that isn't visible from import statements alone.
 */

import { readFile, access } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { readdir } from 'node:fs/promises';
import { createLogger } from '@ekg/shared';
import type { ParsedDatabaseUsage, Logger } from '@ekg/shared';

export interface ConfigScanResult {
  readonly filePath: string;
  readonly databaseUsages: readonly ParsedDatabaseUsage[];
  readonly envVars: readonly EnvVarDefinition[];
}

export interface EnvVarDefinition {
  readonly key: string;
  readonly value?: string;
  readonly isDatabaseRelated: boolean;
}

// Patterns that indicate a database connection
const DB_URL_PATTERNS: readonly { pattern: RegExp; dbType: string }[] = [
  { pattern: /mongodb(\+srv)?:\/\//i, dbType: 'MongoDB' },
  { pattern: /postgres(ql)?:\/\//i, dbType: 'PostgreSQL' },
  { pattern: /mysql:\/\//i, dbType: 'MySQL' },
  { pattern: /redis:\/\//i, dbType: 'Redis' },
  { pattern: /couchbase:\/\//i, dbType: 'Couchbase' },
  { pattern: /amqp:\/\//i, dbType: 'RabbitMQ' },
  { pattern: /mssql:\/\//i, dbType: 'MSSQL' },
];

const DB_KEY_PATTERNS: readonly RegExp[] = [
  /database.?url/i,
  /db.?url/i,
  /db.?host/i,
  /db.?connection/i,
  /mongo.?uri/i,
  /redis.?url/i,
  /redis.?host/i,
  /postgres.?url/i,
  /mysql.?host/i,
  /couchbase.?url/i,
  /couchbase.?host/i,
  /connection.?string/i,
];

export class ConfigScanner {
  private readonly logger: Logger;

  constructor() {
    this.logger = createLogger({ service: 'config-scanner' });
  }

  /**
   * Scan a repository directory for config files and extract DB references.
   */
  async scan(repoDir: string): Promise<readonly ConfigScanResult[]> {
    const results: ConfigScanResult[] = [];

    // Scan .env files
    const envFiles = ['.env', '.env.example', '.env.development', '.env.production', '.env.local'];
    for (const envFile of envFiles) {
      const envPath = join(repoDir, envFile);
      if (await this.exists(envPath)) {
        const result = await this.scanEnvFile(envPath);
        results.push(result);
      }
    }

    // Scan config directories
    const configDirs = ['config', 'configs', 'conf', 'settings'];
    for (const configDir of configDirs) {
      const dirPath = join(repoDir, configDir);
      if (await this.exists(dirPath)) {
        const configResults = await this.scanConfigDirectory(dirPath);
        results.push(...configResults);
      }
    }

    // Scan docker-compose files
    const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
    for (const composeFile of composeFiles) {
      const composePath = join(repoDir, composeFile);
      if (await this.exists(composePath)) {
        const result = await this.scanDockerCompose(composePath);
        results.push(result);
      }
    }

    const totalDbs = results.reduce((sum, r) => sum + r.databaseUsages.length, 0);
    this.logger.info({
      repoDir,
      configFilesScanned: results.length,
      databasesDetected: totalDbs,
    }, 'Config scan completed');

    return results;
  }

  /**
   * Parse a .env file and extract database-related variables.
   */
  private async scanEnvFile(filePath: string): Promise<ConfigScanResult> {
    const content = await readFile(filePath, 'utf-8');
    const envVars: EnvVarDefinition[] = [];
    const databaseUsages: ParsedDatabaseUsage[] = [];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const eqIndex = trimmed.indexOf('=');
      if (eqIndex === -1) continue;

      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim().replace(/^["']|["']$/g, '');

      const isDatabaseRelated = this.isDbRelatedKey(key) || this.detectDbInValue(value) !== undefined;

      envVars.push({ key, value, isDatabaseRelated });

      // Detect DB type from value
      const dbType = this.detectDbInValue(value);
      if (dbType) {
        databaseUsages.push({
          databaseType: dbType,
          detectedVia: 'config_file',
          packageName: basename(filePath),
        });
      }

      // Detect DB type from key name
      if (!dbType && this.isDbRelatedKey(key)) {
        const inferredType = this.inferDbTypeFromKey(key);
        if (inferredType) {
          databaseUsages.push({
            databaseType: inferredType,
            detectedVia: 'config_file',
            packageName: basename(filePath),
          });
        }
      }
    }

    return { filePath, databaseUsages: this.deduplicateDbUsages(databaseUsages), envVars };
  }

  /**
   * Scan a config directory for JSON files with database settings.
   */
  private async scanConfigDirectory(dirPath: string): Promise<ConfigScanResult[]> {
    const results: ConfigScanResult[] = [];

    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (ext !== '.json' && ext !== '.js' && ext !== '.ts') continue;

      const filePath = join(dirPath, entry.name);

      if (ext === '.json') {
        const result = await this.scanJsonConfig(filePath);
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Scan a JSON config file for database-related values.
   */
  private async scanJsonConfig(filePath: string): Promise<ConfigScanResult> {
    const databaseUsages: ParsedDatabaseUsage[] = [];

    try {
      const content = await readFile(filePath, 'utf-8');
      const json = JSON.parse(content) as Record<string, unknown>;
      this.walkJsonForDb(json, databaseUsages, filePath);
    } catch {
      // Not valid JSON or unreadable — skip
    }

    return { filePath, databaseUsages: this.deduplicateDbUsages(databaseUsages), envVars: [] };
  }

  /**
   * Recursively walk a JSON object looking for DB connection strings.
   */
  private walkJsonForDb(
    obj: unknown,
    results: ParsedDatabaseUsage[],
    filePath: string,
    path = '',
  ): void {
    if (obj === null || obj === undefined) return;

    if (typeof obj === 'string') {
      const dbType = this.detectDbInValue(obj);
      if (dbType) {
        results.push({
          databaseType: dbType,
          detectedVia: 'config_file',
          packageName: basename(filePath),
        });
      }
      return;
    }

    if (typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
        this.walkJsonForDb(value, results, filePath, `${path}.${key}`);
      }
    }

    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.walkJsonForDb(item, results, filePath, path);
      }
    }
  }

  /**
   * Scan docker-compose.yml for database service images.
   */
  private async scanDockerCompose(filePath: string): Promise<ConfigScanResult> {
    const databaseUsages: ParsedDatabaseUsage[] = [];

    try {
      const content = await readFile(filePath, 'utf-8');

      // Simple pattern matching — not a full YAML parser
      const dbImagePatterns: { pattern: RegExp; dbType: string }[] = [
        { pattern: /image:\s*['"]?mongo/im, dbType: 'MongoDB' },
        { pattern: /image:\s*['"]?postgres/im, dbType: 'PostgreSQL' },
        { pattern: /image:\s*['"]?mysql/im, dbType: 'MySQL' },
        { pattern: /image:\s*['"]?redis/im, dbType: 'Redis' },
        { pattern: /image:\s*['"]?couchbase/im, dbType: 'Couchbase' },
        { pattern: /image:\s*['"]?neo4j/im, dbType: 'Neo4j' },
        { pattern: /image:\s*['"]?rabbitmq/im, dbType: 'RabbitMQ' },
        { pattern: /image:\s*['"]?elasticsearch/im, dbType: 'Elasticsearch' },
      ];

      for (const { pattern, dbType } of dbImagePatterns) {
        if (pattern.test(content)) {
          databaseUsages.push({
            databaseType: dbType,
            detectedVia: 'config_file',
            packageName: basename(filePath),
          });
        }
      }
    } catch {
      // Unreadable — skip
    }

    return { filePath, databaseUsages, envVars: [] };
  }

  // -- Helpers --

  private detectDbInValue(value: string): string | undefined {
    for (const { pattern, dbType } of DB_URL_PATTERNS) {
      if (pattern.test(value)) return dbType;
    }
    return undefined;
  }

  private isDbRelatedKey(key: string): boolean {
    return DB_KEY_PATTERNS.some((p) => p.test(key));
  }

  private inferDbTypeFromKey(key: string): string | undefined {
    const lower = key.toLowerCase();
    if (lower.includes('mongo')) return 'MongoDB';
    if (lower.includes('redis')) return 'Redis';
    if (lower.includes('postgres') || lower.includes('pg')) return 'PostgreSQL';
    if (lower.includes('mysql')) return 'MySQL';
    if (lower.includes('couchbase') || lower.includes('cb')) return 'Couchbase';
    return undefined;
  }

  private deduplicateDbUsages(usages: ParsedDatabaseUsage[]): ParsedDatabaseUsage[] {
    const seen = new Set<string>();
    return usages.filter((u) => {
      const key = `${u.databaseType}:${u.detectedVia}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }
}
