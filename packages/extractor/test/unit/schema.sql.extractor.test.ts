import { describe, it, expect } from 'vitest';
import { SchemaSqlExtractor } from '../../src/schema.sql.extractor.js';

const REPO = 'https://gitlab.com/o/r';

describe('SchemaSqlExtractor', () => {
  it('extracts CREATE TABLE with columns and a Migration node', () => {
    const sql = `CREATE TABLE users (
      id BIGINT PRIMARY KEY,
      email VARCHAR(255) NOT NULL UNIQUE,
      name VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );`;
    const r = new SchemaSqlExtractor().extract(sql, 'db/migrations/V1__init.sql', REPO);
    expect(r.migrations).toHaveLength(1);
    expect(r.migrations[0]!.properties['flywayKind']).toBe('V');
    expect(r.tables.map((t) => t.name)).toEqual(['users']);
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['nullable']).toBe(false);
    expect(email.properties['isUnique']).toBe(true);
    const created = r.columns.find((c) => c.name === 'created_at')!;
    expect(created.properties['defaultValue']).toBe('CURRENT_TIMESTAMP');
    expect(r.relations.some((rel) => rel.type === 'ALTERS' && (rel.properties as Record<string, unknown>)['kind'] === 'CREATE')).toBe(true);
  });

  it('honours table-level PRIMARY KEY constraints', () => {
    const sql = `CREATE TABLE order_item (
      order_id INT NOT NULL,
      sku VARCHAR(64) NOT NULL,
      qty INT NOT NULL,
      PRIMARY KEY (order_id, sku)
    );`;
    const r = new SchemaSqlExtractor().extract(sql, 'V2__create.sql', REPO);
    const order = r.columns.find((c) => c.name === 'order_id')!;
    const sku = r.columns.find((c) => c.name === 'sku')!;
    expect(order.properties['isPrimary']).toBe(true);
    expect(sku.properties['isPrimary']).toBe(true);
  });

  it('emits ALTERS edges for ALTER and DROP without CREATE', () => {
    const sql = `ALTER TABLE users ADD COLUMN deleted_at TIMESTAMP NULL;
                 DROP TABLE IF EXISTS old_audit;`;
    const r = new SchemaSqlExtractor().extract(sql, 'V3__alter.sql', REPO);
    const alters = r.relations.filter((rel) => rel.type === 'ALTERS');
    expect(alters.map((a) => (a.properties as Record<string, unknown>)['kind']).sort()).toEqual(['ALTER', 'DROP']);
  });

  it('returns empty when SQL has no DDL', () => {
    const r = new SchemaSqlExtractor().extract('SELECT 1;', 'q.sql', REPO);
    expect(r.migrations).toHaveLength(0);
  });

  it('parses Liquibase XML createTable + columns + alters', () => {
    const xml = `
<databaseChangeLog>
  <changeSet id="1" author="me">
    <createTable tableName="customers">
      <column name="id" type="BIGINT">
        <constraints primaryKey="true" nullable="false"/>
      </column>
      <column name="email" type="VARCHAR(255)">
        <constraints unique="true" nullable="false"/>
      </column>
    </createTable>
  </changeSet>
  <changeSet id="2" author="me">
    <addColumn tableName="customers">
      <column name="phone" type="VARCHAR(32)"/>
    </addColumn>
  </changeSet>
</databaseChangeLog>`;
    const r = new SchemaSqlExtractor().extract(xml, 'changelog.xml', REPO);
    expect(r.migrations).toHaveLength(1);
    expect(r.tables.map((t) => t.name)).toEqual(['customers']);
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    expect(id.properties['nullable']).toBe(false);
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['isUnique']).toBe(true);
    expect(r.relations.some((rel) => rel.type === 'ALTERS' && (rel.properties as Record<string, unknown>)['kind'] === 'ALTER')).toBe(true);
  });
});
