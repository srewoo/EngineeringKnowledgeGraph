import { describe, it, expect } from 'vitest';
import { SchemaTsOrmExtractor } from '../../src/schema.ts.orm.extractor.js';

const REPO = 'https://gitlab.com/o/r';
const PATH = 'src/entities/user.ts';

describe('SchemaTsOrmExtractor', () => {
  it('returns empty when no ORM markers present', () => {
    const ex = new SchemaTsOrmExtractor();
    const r = ex.extract('export const x = 1;', PATH, REPO);
    expect(r.tables).toHaveLength(0);
    expect(r.columns).toHaveLength(0);
  });

  it('extracts a TypeORM @Entity with columns', () => {
    const src = `
      import { Entity, Column, PrimaryGeneratedColumn } from 'typeorm';
      @Entity('users')
      export class User {
        @PrimaryGeneratedColumn()
        id!: number;
        @Column({ type: 'varchar', nullable: false, unique: true })
        email!: string;
        @Column({ nullable: true })
        name?: string;
      }
    `;
    const r = new SchemaTsOrmExtractor().extract(src, PATH, REPO);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.name).toBe('users');
    const cols = r.columns.map((c) => c.name).sort();
    expect(cols).toEqual(['email', 'id', 'name']);
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['isUnique']).toBe(true);
    expect(email.properties['type']).toBe('varchar');
    expect(r.relations.every((rel) => rel.type === 'HAS')).toBe(true);
  });

  it('falls back to class name when @Entity has no explicit name', () => {
    const src = `@Entity() export class Order { @PrimaryColumn() id!: string; }`;
    const r = new SchemaTsOrmExtractor().extract(src, PATH, REPO);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.name).toBe('Order');
  });

  it('extracts a Drizzle pgTable with primaryKey/notNull/unique', () => {
    const src = `
      import { pgTable, serial, text, varchar } from 'drizzle-orm/pg-core';
      export const users = pgTable('users', {
        id: serial('id').primaryKey(),
        email: varchar('email', { length: 255 }).notNull().unique(),
        name: text('name'),
      });
    `;
    const r = new SchemaTsOrmExtractor().extract(src, PATH, REPO);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.properties['orm']).toBe('drizzle');
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['isUnique']).toBe(true);
    expect(email.properties['nullable']).toBe(false);
    const name = r.columns.find((c) => c.name === 'name')!;
    expect(name.properties['nullable']).toBe(true);
  });

  it('extracts a Sequelize sequelize.define call', () => {
    const src = `
      const User = sequelize.define('User', {
        id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        email: { type: DataTypes.STRING, allowNull: false, unique: true },
        name: DataTypes.STRING,
      });
    `;
    const r = new SchemaTsOrmExtractor().extract(src, PATH, REPO);
    expect(r.tables).toHaveLength(1);
    expect(r.tables[0]!.name).toBe('User');
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    expect(id.properties['type']).toBe('INTEGER');
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['nullable']).toBe(false);
    expect(email.properties['isUnique']).toBe(true);
  });

  it('extracts a Sequelize Model.init class', () => {
    const src = `
      class Product extends Model {}
      Product.init({
        id: { type: DataTypes.UUID, primaryKey: true },
        sku: { type: DataTypes.STRING, allowNull: false },
      }, { sequelize, modelName: 'Product' });
    `;
    const r = new SchemaTsOrmExtractor().extract(src, PATH, REPO);
    expect(r.tables.map((t) => t.name)).toEqual(['Product']);
    expect(r.columns.map((c) => c.name).sort()).toEqual(['id', 'sku']);
  });
});
