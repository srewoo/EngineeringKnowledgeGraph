/**
 * SchemaDriftDetector — flags schema / migration drift in an extraction
 * result so the embeddings layer can invalidate stale Function/Doc/Table
 * embeddings.
 *
 * Drift signal sources (any one is enough):
 *  - any new `Migration` node;
 *  - any new `Table` node;
 *  - any `HAS` edge whose Column target is new (column added).
 *
 * "New" is decided against the EmbeddingsRepository — if we don't already
 * have an embedding for that node id, treat it as new. This reuses the
 * embedding row as a poor-person's "what did we last process" cache without
 * adding a separate state table.
 *
 * The detector returns the list of affected service ids (derived from
 * `OWNS` edges) so the caller can scope the invalidation to those services.
 */

import type { GraphNode, GraphRelationship } from '@ekg/shared';
import type { EmbeddingsRepository } from '@ekg/storage';

export interface DriftSignal {
  readonly drifted: boolean;
  readonly newMigrations: readonly string[];
  readonly newTables: readonly string[];
  readonly newColumns: readonly string[];
  /** Service node ids that own one of the changed tables. */
  readonly affectedServices: readonly string[];
}

export class SchemaDriftDetector {
  /**
   * Inspect the extraction's nodes + relationships and decide whether to
   * trigger a re-embed. Pass `repo` if available to compare against
   * already-embedded ids; without it we conservatively flag every
   * Migration/Table/Column as new.
   */
  detect(
    nodes: readonly GraphNode[],
    relationships: readonly GraphRelationship[],
    repo: EmbeddingsRepository | undefined,
  ): DriftSignal {
    const newMigrations: string[] = [];
    const newTables: string[] = [];
    const newColumns: string[] = [];

    const isNew = (id: string): boolean => {
      if (!repo) return true;
      return repo.findByNodeId(id) === undefined;
    };

    for (const n of nodes) {
      if (n.label === 'Migration' && isNew(n.id)) newMigrations.push(n.id);
      else if (n.label === 'Table' && isNew(n.id)) newTables.push(n.id);
      else if (n.label === 'Column' && isNew(n.id)) newColumns.push(n.id);
    }

    const drifted = newMigrations.length > 0 || newTables.length > 0 || newColumns.length > 0;
    if (!drifted) {
      return {
        drifted: false,
        newMigrations: [],
        newTables: [],
        newColumns: [],
        affectedServices: [],
      };
    }

    // Walk OWNS edges to find services owning the changed tables.
    const affectedTableIds = new Set<string>([
      ...newTables,
      // ALTERS edges target a Table id, even if the Table node itself is
      // older than the migration that touched it.
      ...relationships
        .filter((r) => r.type === 'ALTERS')
        .map((r) => r.targetId),
    ]);
    const affectedServices = new Set<string>();
    for (const r of relationships) {
      if (r.type !== 'OWNS') continue;
      if (affectedTableIds.has(r.targetId) && r.sourceId.startsWith('service:')) {
        affectedServices.add(r.sourceId);
      }
    }

    return {
      drifted: true,
      newMigrations,
      newTables,
      newColumns,
      affectedServices: [...affectedServices],
    };
  }
}
