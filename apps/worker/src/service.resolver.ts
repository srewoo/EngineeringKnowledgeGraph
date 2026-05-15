/**
 * URL-to-service resolver — links HTTP calls to known service nodes.
 *
 * After all repos are ingested, this pass looks at HTTP call
 * relationships and tries to match their URLs to service names.
 * Resolves patterns like:
 *   - http://user-service/api → links to Service "user-service"
 *   - http://localhost:3001/api → links to service on port 3001
 *   - /api/users → links to matching API node
 */

import type { Session } from 'neo4j-driver';
import { createLogger } from '@ekg/shared';
import { Neo4jClient } from '@ekg/graph';
import type { Logger } from '@ekg/shared';

interface ResolvedLink {
  readonly sourceService: string;
  readonly targetService: string;
  readonly url: string;
  readonly confidence: string;
}

export class ServiceResolver {
  private readonly client: Neo4jClient;
  private readonly logger: Logger;

  constructor(client: Neo4jClient) {
    this.client = client;
    this.logger = createLogger({ service: 'service-resolver' });
  }

  /**
   * Run the resolution pass across the entire graph.
   * Matches HTTP call URLs to known service names.
   */
  async resolve(): Promise<readonly ResolvedLink[]> {
    const session = this.client.getSession();
    const resolved: ResolvedLink[] = [];

    try {
      // Step 1: Get all services with their names
      const servicesResult = await session.run(
        `MATCH (s:Service) RETURN s.name AS name, s.id AS id`,
      );
      const serviceNames = servicesResult.records.map((r) => ({
        name: (r.get('name') as string).toLowerCase(),
        id: r.get('id') as string,
      }));

      if (serviceNames.length === 0) {
        this.logger.info('No services found — skipping resolution');
        return [];
      }

      // Step 2: Get all HTTP calls (CALLS relationships)
      const callsResult = await session.run(
        `MATCH (source)-[r:CALLS]->(target)
         WHERE r.url IS NOT NULL
         RETURN source.id AS sourceId, r.url AS url, r.method AS method, id(r) AS relId`,
      );

      for (const record of callsResult.records) {
        const sourceId = record.get('sourceId') as string;
        const url = record.get('url') as string;

        // Try to match URL to a service
        const matchedService = this.matchUrlToService(url, serviceNames);
        if (!matchedService) continue;

        // Find which service the source file belongs to
        const sourceService = await this.findFileService(session, sourceId);
        if (!sourceService || sourceService === matchedService.id) continue;

        // Create a CALLS relationship between the two services
        await session.run(
          `MATCH (source:Service {id: $sourceId})
           MATCH (target:Service {id: $targetId})
           MERGE (source)-[r:CALLS]->(target)
           SET r.confidence = $confidence,
               r.url = $url,
               r.resolvedAt = datetime(),
               r.updatedAt = datetime()`,
          {
            sourceId: sourceService,
            targetId: matchedService.id,
            confidence: matchedService.confidence,
            url,
          },
        );

        resolved.push({
          sourceService,
          targetService: matchedService.id,
          url,
          confidence: matchedService.confidence,
        });
      }

      this.logger.info({
        totalResolved: resolved.length,
        totalServices: serviceNames.length,
      }, 'Service resolution completed');

      return resolved;
    } finally {
      await session.close();
    }
  }

  /**
   * Match a URL string to a known service.
   *
   * Supports:
   *   - Direct hostname: http://user-service/api, http://user-service:3000/...
   *   - Kubernetes DNS: http://user-service.default.svc.cluster.local/...
   *   - Env-substituted templates: ${USER_SERVICE_URL}/api → matches "user_service"
   *   - Template-literal placeholders: {var}, ${VAR} normalised before match
   *   - kebab/underscore/dot variants
   */
  private matchUrlToService(
    url: string,
    services: readonly { name: string; id: string }[],
  ): { id: string; confidence: string } | undefined {
    if (!url) return undefined;

    // Normalise template placeholders so they don't break the URL parser
    const normalised = url
      .replace(/\$\{[A-Z_][A-Z0-9_]*\}/g, '{var}')
      .replace(/\$\{[^}]*\}/g, '{var}');

    // Extract hostname segment for hostname-based matching
    const hostMatch = /^[a-z]+:\/\/([^\/:?#]+)/i.exec(normalised);
    const host = hostMatch?.[1]?.toLowerCase() ?? '';

    // Strip K8s DNS suffix if present
    const k8sStripped = host.replace(/\.[\w-]+\.svc(\.cluster\.local)?$/, '');

    const lower = normalised.toLowerCase();

    // Pass 1: HIGH confidence — hostname match
    for (const svc of services) {
      const name = svc.name.toLowerCase();
      if (host === name || k8sStripped === name) {
        return { id: svc.id, confidence: 'HIGH' };
      }
      if (host.startsWith(`${name}.`) || host.startsWith(`${name}-`)) {
        return { id: svc.id, confidence: 'HIGH' };
      }
    }

    // Pass 2: HIGH — env-style placeholder that names the service
    // e.g. ${USER_SERVICE_URL}/api → tokens [user, service, url]
    const envTokens = [...lower.matchAll(/\{var\}/g)].length > 0
      ? this.tokensFromEnvNames(url)
      : [];
    if (envTokens.length > 0) {
      for (const svc of services) {
        const svcTokens = svc.name.toLowerCase().split(/[-_]/g);
        const overlap = svcTokens.filter((t) => t.length > 2 && envTokens.includes(t));
        if (overlap.length >= Math.min(2, svcTokens.length)) {
          return { id: svc.id, confidence: 'HIGH' };
        }
      }
    }

    // Pass 3: MEDIUM — substring match on kebab/underscore variants
    for (const svc of services) {
      const variants = new Set([
        svc.name.toLowerCase(),
        svc.name.toLowerCase().replace(/-/g, '_'),
        svc.name.toLowerCase().replace(/_/g, '-'),
      ]);
      for (const v of variants) {
        if (v.length > 2 && lower.includes(v)) {
          return { id: svc.id, confidence: 'MEDIUM' };
        }
      }
    }

    return undefined;
  }

  /** Pull lowercase tokens out of any ${UPPER_SNAKE} placeholders in the URL. */
  private tokensFromEnvNames(url: string): string[] {
    const out = new Set<string>();
    for (const m of url.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      for (const t of m[1]!.toLowerCase().split('_')) {
        if (t && t !== 'url' && t !== 'host' && t !== 'endpoint') out.add(t);
      }
    }
    return [...out];
  }

  /**
   * Find which service a file belongs to.
   */
  private async findFileService(
    session: Session,
    fileId: string,
  ): Promise<string | undefined> {
    const result = await session.run(
      `MATCH (s:Service)-[:CONTAINS]->(f {id: $fileId})
       RETURN s.id AS serviceId
       LIMIT 1`,
      { fileId },
    );

    return result.records[0]?.get('serviceId') as string | undefined;
  }
}
