/**
 * Shared constants for the EKG system.
 *
 * Centralised to avoid magic strings and ensure consistency
 * across packages when referencing node labels, relationship types,
 * and file filtering rules.
 */

import type { NodeLabel, RelationshipType } from './types/graph.types.js';

// -- Node Labels --

export const NODE_LABELS: readonly NodeLabel[] = [
  'Service', 'API', 'Database', 'Repo', 'File',
  'Module', 'Config', 'MessageQueue', 'Feature', 'TestCase',
  'Owner', 'Team',
] as const;

// -- Relationship Types --

export const RELATIONSHIP_TYPES: readonly RelationshipType[] = [
  'IMPORTS', 'EXPORTS', 'USES', 'CALLS', 'EXPOSES',
  'CONTAINS', 'DEPENDS_ON', 'READS_CONFIG', 'IMPLEMENTS', 'TESTS',
  'OWNS', 'MEMBER_OF',
] as const;

// -- File Filtering --

export const DEFAULT_IGNORE_DIRS: readonly string[] = [
  // JS/TS
  'node_modules', 'dist', 'build', 'coverage',
  '.next', '.nuxt', '.cache', '.turbo', '.vercel', '.output',
  // Git/CI
  '.git', '.github', '.gitlab', '.idea', '.vscode',
  // Python
  '__pycache__', '.venv', 'venv', 'env', '.tox', '.pytest_cache',
  '.mypy_cache', '.ruff_cache', 'site-packages', 'eggs', '.eggs',
  // Java/Kotlin/JVM
  'target', '.gradle', '.m2', 'out', 'classes', 'generated',
  // Go
  'vendor',
  // Rust
  'Cargo.lock.d',
  // Misc
  'tmp', 'temp', 'logs', '.terraform',
] as const;

/**
 * Source code extensions across mainstream languages.
 * Excludes binaries, archives, media, lockfiles, and minified bundles.
 */
export const DEFAULT_SUPPORTED_EXTENSIONS: readonly string[] = [
  // JavaScript / TypeScript
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  // Java / Kotlin / Scala / Groovy
  '.java', '.kt', '.kts', '.scala', '.groovy',
  // Go
  '.go',
  // Python
  '.py', '.pyi',
  // Rust
  '.rs',
  // Ruby / PHP / .NET / Swift
  '.rb', '.php', '.cs', '.fs', '.vb', '.swift', '.m', '.mm',
  // C / C++
  '.c', '.h', '.cpp', '.cc', '.hpp', '.hh', '.cxx',
  // Shell / scripting
  '.sh', '.bash', '.zsh', '.ps1',
  // Schema / IDL
  '.graphql', '.gql', '.proto', '.thrift',
  // Config / data
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  // Infra
  '.tf', '.hcl',
] as const;

/**
 * Files scanned by name (not extension) for architectural info.
 */
export const SCAN_BY_NAME: readonly string[] = [
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'package.json', 'go.mod', 'go.sum',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'requirements.txt', 'Pipfile', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'Cargo.toml', 'Gemfile', 'composer.json',
  'Makefile', 'Procfile',
] as const;

/**
 * Hard-block extensions: binaries, archives, media, fonts, compiled artefacts.
 * These are NEVER parsed and NEVER counted as source files.
 */
export const BINARY_AND_LIBRARY_EXTENSIONS: ReadonlySet<string> = new Set([
  // Compiled / packaged libs
  '.jar', '.war', '.ear', '.aar',
  '.class', '.pyc', '.pyo', '.pyd',
  '.dll', '.so', '.dylib', '.a', '.lib', '.o', '.obj',
  '.exe', '.bin', '.app', '.dmg', '.pkg', '.msi', '.deb', '.rpm', '.apk', '.ipa',
  '.wasm',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.iso',
  // Images / media / fonts
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.tiff', '.ico', '.webp', '.avif',
  '.svg', '.psd', '.ai', '.sketch',
  '.mp3', '.mp4', '.wav', '.flac', '.ogg', '.webm', '.mov', '.avi', '.mkv',
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Documents
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // DBs / data dumps
  '.sqlite', '.db', '.mdb', '.parquet', '.avro',
  // Source maps / minified bundles
  '.map', '.min.js', '.min.css',
]);

/**
 * Lockfiles and vendored manifests — never source-of-truth for graph extraction.
 */
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'shrinkwrap.yaml',
  'Cargo.lock', 'Pipfile.lock', 'poetry.lock', 'composer.lock', 'Gemfile.lock',
  'go.sum',
  'mix.lock',
]);

/** Skip files larger than this when parsing source — protects against checked-in bundles. */
export const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

// -- Database SDK Detection (cross-language) --

export const DATABASE_SDK_MAP: Readonly<Record<string, string>> = {
  // JS / TS
  'couchbase': 'Couchbase',
  'mongoose': 'MongoDB',
  'mongodb': 'MongoDB',
  'pg': 'PostgreSQL',
  'mysql2': 'MySQL',
  'mysql': 'MySQL',
  'redis': 'Redis',
  'ioredis': 'Redis',
  'better-sqlite3': 'SQLite',
  'sqlite3': 'SQLite',
  'typeorm': 'TypeORM',
  'sequelize': 'Sequelize',
  'prisma': 'Prisma',
  '@prisma/client': 'Prisma',
  'knex': 'Knex',
  'drizzle-orm': 'Drizzle',
  'cassandra-driver': 'Cassandra',
  '@elastic/elasticsearch': 'Elasticsearch',
  'neo4j-driver': 'Neo4j',
  'mssql': 'MSSQL',
  // Python
  'psycopg2': 'PostgreSQL', 'psycopg': 'PostgreSQL', 'asyncpg': 'PostgreSQL',
  'pymongo': 'MongoDB', 'motor': 'MongoDB',
  'redis-py': 'Redis', 'aioredis': 'Redis',
  'sqlalchemy': 'SQLAlchemy', 'pymysql': 'MySQL',
  'cassandra-driver-py': 'Cassandra',
  'elasticsearch': 'Elasticsearch',
  'cx_Oracle': 'Oracle',
  // Java
  'org.springframework.data.mongodb': 'MongoDB',
  'org.springframework.data.redis': 'Redis',
  'org.postgresql': 'PostgreSQL',
  'com.mysql': 'MySQL',
  'org.hibernate': 'Hibernate',
  'redis.clients.jedis': 'Redis',
  'com.couchbase.client': 'Couchbase',
  'org.elasticsearch.client': 'Elasticsearch',
  'oracle.jdbc': 'Oracle',
  // Go
  'github.com/lib/pq': 'PostgreSQL',
  'github.com/jackc/pgx': 'PostgreSQL',
  'github.com/go-sql-driver/mysql': 'MySQL',
  'go.mongodb.org/mongo-driver': 'MongoDB',
  'github.com/redis/go-redis': 'Redis',
  'github.com/go-redis/redis': 'Redis',
  'github.com/couchbase/gocb': 'Couchbase',
  'github.com/elastic/go-elasticsearch': 'Elasticsearch',
  'gorm.io/gorm': 'GORM',
  // Rust
  'sqlx': 'SQLx',
  'diesel': 'Diesel',
  'mongodb-rs': 'MongoDB',
  'redis-rs': 'Redis',
};

// -- HTTP Client Detection --

export const HTTP_CLIENT_PACKAGES: readonly string[] = [
  // JS/TS
  'axios', 'node-fetch', 'got', 'undici', 'ky', 'superagent',
  // Python
  'requests', 'httpx', 'aiohttp', 'urllib3',
  // Java
  'org.apache.httpcomponents', 'okhttp3', 'java.net.http', 'org.springframework.web.client',
  // Go
  'net/http', 'github.com/go-resty/resty', 'github.com/valyala/fasthttp',
  // Rust
  'reqwest', 'hyper', 'isahc', 'surf',
] as const;

// -- Message Queue Detection --

export const MESSAGE_QUEUE_PACKAGES: readonly string[] = [
  // JS/TS
  'kafkajs', 'amqplib', 'bullmq', 'bull', '@nestjs/bull', 'sqs-consumer',
  // Python
  'kafka-python', 'confluent-kafka', 'pika', 'celery', 'aio-pika',
  // Java
  'org.apache.kafka', 'com.rabbitmq', 'org.springframework.kafka',
  // Go
  'github.com/segmentio/kafka-go', 'github.com/Shopify/sarama', 'github.com/streadway/amqp',
  // Rust
  'rdkafka', 'lapin',
] as const;

// -- Framework Detection (API routes) --

export const API_FRAMEWORK_PACKAGES: readonly string[] = [
  // JS/TS
  'express', 'fastify', '@nestjs/common', 'koa', 'hapi', '@hapi/hapi',
  // Python
  'flask', 'fastapi', 'django', 'aiohttp.web', 'starlette', 'tornado',
  // Java
  'org.springframework.web', 'jakarta.ws.rs', 'javax.ws.rs', 'io.javalin', 'spark.Spark',
  // Go
  'github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/gorilla/mux',
  'net/http', 'github.com/gofiber/fiber',
  // Rust
  'actix-web', 'axum', 'rocket', 'warp',
  // Ruby / PHP / .NET
  'rails', 'sinatra', 'laravel', 'symfony',
] as const;

// -- Graph Constraints --

export const MAX_TRAVERSAL_DEPTH = 10;
export const DEFAULT_QUERY_LIMIT = 20;
export const MAX_QUERY_LIMIT = 100;
