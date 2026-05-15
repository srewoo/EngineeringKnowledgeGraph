/**
 * Neo4j connection client.
 *
 * Manages driver lifecycle, session creation, and health checks.
 * All graph operations go through this client.
 */

import neo4j, {
  type Driver,
  type ManagedTransaction,
  type Session,
  type SessionMode,
} from 'neo4j-driver';
import { createLogger } from '@ekg/shared';
import type { Logger } from '@ekg/shared';

export interface Neo4jClientOptions {
  readonly uri: string;
  readonly user: string;
  readonly password: string;
}

export class Neo4jClient {
  private readonly driver: Driver;
  private readonly logger: Logger;

  constructor(options: Neo4jClientOptions) {
    this.logger = createLogger({ service: 'neo4j-client' });

    this.driver = neo4j.driver(
      options.uri,
      neo4j.auth.basic(options.user, options.password),
      {
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 60_000,
        maxTransactionRetryTime: 30_000,
        // Ping pooled connections idle longer than this before reuse — prevents
        // handing out a socket silently dropped by an LB/firewall.
        connectionLivenessCheckTimeout: 30_000,
        // Recycle connections before typical 1h LB idle cutoff.
        maxConnectionLifetime: 30 * 60 * 1000,
        // Cap individual socket connect time so a stuck endpoint fails fast
        // instead of pinning the pool for 120s.
        connectionTimeout: 20_000,
      },
    );

    this.logger.info({ uri: options.uri }, 'Neo4j driver created');
  }

  async verifyConnectivity(): Promise<void> {
    try {
      await this.driver.verifyConnectivity();
      this.logger.info('Neo4j connectivity verified');
    } catch (error) {
      this.logger.error({ error }, 'Neo4j connectivity check failed');
      throw error;
    }
  }

  getSession(mode: SessionMode = neo4j.session.WRITE): Session {
    return this.driver.session({ defaultAccessMode: mode });
  }

  getReadSession(): Session {
    return this.driver.session({ defaultAccessMode: neo4j.session.READ });
  }

  /**
   * Execute a write inside a managed transaction. The driver retries
   * transient errors (ServiceUnavailable, SessionExpired, deadlocks) using
   * its own backoff up to maxTransactionRetryTime.
   */
  async executeWrite<T>(
    work: (tx: ManagedTransaction) => Promise<T>,
    timeoutMs = 300_000,
  ): Promise<T> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.WRITE,
    });
    try {
      return await session.executeWrite(work, { timeout: timeoutMs });
    } finally {
      await session.close();
    }
  }

  async executeRead<T>(
    work: (tx: ManagedTransaction) => Promise<T>,
    timeoutMs = 300_000,
  ): Promise<T> {
    const session = this.driver.session({
      defaultAccessMode: neo4j.session.READ,
    });
    try {
      return await session.executeRead(work, { timeout: timeoutMs });
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
    this.logger.info('Neo4j driver closed');
  }
}
