import { describe, it, expect } from 'vitest';
import { SchemaPythonExtractor } from '../../src/schema.python.extractor.js';

const REPO = 'https://gitlab.com/o/r';
const PATH = 'app/models.py';

describe('SchemaPythonExtractor', () => {
  it('returns empty for non-ORM content', () => {
    const r = new SchemaPythonExtractor().extract('x = 1\n', PATH, REPO);
    expect(r.tables).toHaveLength(0);
  });

  it('extracts SQLAlchemy declarative class with __tablename__', () => {
    const src = [
      'from sqlalchemy import Column, Integer, String',
      'from sqlalchemy.orm import DeclarativeBase',
      'class Base(DeclarativeBase): pass',
      'class User(Base):',
      "    __tablename__ = 'users'",
      '    id = Column(Integer, primary_key=True)',
      '    email = Column(String(255), nullable=False, unique=True)',
      '    name = Column(String(255), nullable=True)',
      '',
    ].join('\n');
    const r = new SchemaPythonExtractor().extract(src, PATH, REPO);
    expect(r.tables.map((t) => t.name)).toEqual(['users']);
    const id = r.columns.find((c) => c.name === 'id')!;
    expect(id.properties['isPrimary']).toBe(true);
    const email = r.columns.find((c) => c.name === 'email')!;
    expect(email.properties['isUnique']).toBe(true);
    expect(email.properties['nullable']).toBe(false);
    const name = r.columns.find((c) => c.name === 'name')!;
    expect(name.properties['nullable']).toBe(true);
  });

  it('extracts SQLAlchemy core Table() call', () => {
    const src = [
      'from sqlalchemy import Table, Column, Integer, String, MetaData',
      'metadata = MetaData()',
      "users = Table('accounts', metadata,",
      "    Column('id', Integer, primary_key=True),",
      "    Column('email', String(255), nullable=False, unique=True),",
      ')',
      '',
    ].join('\n');
    const r = new SchemaPythonExtractor().extract(src, PATH, REPO);
    expect(r.tables.map((t) => t.name)).toEqual(['accounts']);
    expect(r.columns.map((c) => c.name).sort()).toEqual(['email', 'id']);
  });

  it('extracts a Django model with Meta.db_table', () => {
    const src = [
      'from django.db import models',
      'class Order(models.Model):',
      '    sku = models.CharField(max_length=64, unique=True)',
      '    qty = models.IntegerField(null=True)',
      '    class Meta:',
      "        db_table = 'orders_t'",
      '',
    ].join('\n');
    const r = new SchemaPythonExtractor().extract(src, PATH, REPO);
    expect(r.tables.map((t) => t.name)).toEqual(['orders_t']);
    const sku = r.columns.find((c) => c.name === 'sku')!;
    expect(sku.properties['type']).toBe('CharField');
    expect(sku.properties['isUnique']).toBe(true);
    const qty = r.columns.find((c) => c.name === 'qty')!;
    expect(qty.properties['nullable']).toBe(true);
  });

  it('falls back to class name when no Meta.db_table is set', () => {
    const src = [
      'from django.db import models',
      'class Customer(models.Model):',
      '    name = models.CharField(max_length=100)',
      '',
    ].join('\n');
    const r = new SchemaPythonExtractor().extract(src, PATH, REPO);
    expect(r.tables[0]!.name).toBe('Customer');
  });
});
