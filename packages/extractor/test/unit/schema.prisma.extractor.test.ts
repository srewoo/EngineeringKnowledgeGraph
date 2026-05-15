import { describe, it, expect } from 'vitest';
import { SchemaPrismaExtractor } from '../../src/schema.prisma.extractor.js';
import type { GraphNode } from '@ekg/shared';

const REPO = 'https://gitlab.com/acme/svc';
const PATH = 'prisma/schema.prisma';

function findCol(cols: readonly GraphNode[], tableName: string, colName: string): GraphNode | undefined {
  return cols.find((c) => c.id.endsWith(`:${tableName}:${colName}`));
}

describe('SchemaPrismaExtractor', () => {
  const extractor = new SchemaPrismaExtractor();

  describe('handles()', () => {
    it('matches schema.prisma by basename', () => {
      expect(SchemaPrismaExtractor.handles('prisma/schema.prisma')).toBe(true);
      expect(SchemaPrismaExtractor.handles('apps/api/prisma/schema.prisma')).toBe(true);
    });

    it('rejects other prisma-like names', () => {
      expect(SchemaPrismaExtractor.handles('schema.ts')).toBe(false);
      expect(SchemaPrismaExtractor.handles('Schema.Prisma')).toBe(false);
      expect(SchemaPrismaExtractor.handles('migration.prisma')).toBe(false);
    });
  });

  describe('empty input', () => {
    it('returns empty result for empty content', () => {
      const r = extractor.extract('', PATH, REPO);
      expect(r.tables).toHaveLength(0);
      expect(r.columns).toHaveLength(0);
      expect(r.relations).toHaveLength(0);
      expect(r.indexes).toHaveLength(0);
    });

    it('returns empty result when no model blocks', () => {
      const r = extractor.extract(
        'datasource db { provider = "postgresql" url = env("DB_URL") }\n',
        PATH,
        REPO,
      );
      expect(r.tables).toHaveLength(0);
    });
  });

  describe('basic model parsing', () => {
    const schema = `
generator client { provider = "prisma-client-js" }

model User {
  id        Int      @id @default(autoincrement())
  email     String   @unique
  name      String?
  createdAt DateTime @default(now()) @map("created_at")
  posts     Post[]
}

model Post {
  id        Int     @id @default(autoincrement())
  title     String
  authorId  Int
  author    User    @relation(fields: [authorId], references: [id])
  tags      Tag[]
  @@index([authorId])
  @@map("posts")
}

model Tag {
  id    Int    @id
  name  String @unique
  posts Post[]
  @@unique([name])
}
`;

    const result = extractor.extract(schema, PATH, REPO);

    it('extracts three tables', () => {
      expect(result.tables.map((t) => t.name).sort()).toEqual(['Post', 'Tag', 'User']);
    });

    it('table id is namespaced by repoUrl', () => {
      const user = result.tables.find((t) => t.name === 'User')!;
      expect(user.id).toBe(`table:${REPO}:User`);
      expect(user.properties).toMatchObject({
        name: 'User',
        repoUrl: REPO,
        filePath: PATH,
      });
      expect(typeof (user.properties as { sourceLine: number }).sourceLine).toBe('number');
    });

    it('captures scalar columns with attrs', () => {
      const id = findCol(result.columns, 'User', 'id')!;
      expect(id.properties).toMatchObject({
        name: 'id',
        type: 'Int',
        nullable: false,
        isPrimary: true,
        isUnique: false,
      });
      expect((id.properties as { defaultValue: string }).defaultValue).toBe('autoincrement()');
    });

    it('captures @unique', () => {
      const email = findCol(result.columns, 'User', 'email')!;
      expect((email.properties as { isUnique: boolean }).isUnique).toBe(true);
    });

    it('captures nullable fields', () => {
      const name = findCol(result.columns, 'User', 'name')!;
      expect((name.properties as { nullable: boolean }).nullable).toBe(true);
    });

    it('captures @default(now()) and @map', () => {
      const created = findCol(result.columns, 'User', 'createdAt')!;
      expect((created.properties as { defaultValue: string }).defaultValue).toBe('now()');
      expect((created.properties as { mappedName: string }).mappedName).toBe('created_at');
    });

    it('skips relation pointer fields (no Column emitted)', () => {
      // `posts Post[]` on User and `author User @relation(...)` on Post
      // are relation pointers — they should NOT produce Column nodes.
      expect(findCol(result.columns, 'User', 'posts')).toBeUndefined();
      expect(findCol(result.columns, 'Post', 'author')).toBeUndefined();
      expect(findCol(result.columns, 'Post', 'tags')).toBeUndefined();
    });

    it('emits HAS edge per scalar column with HIGH confidence', () => {
      const has = result.relations.filter((r) => r.type === 'HAS');
      expect(has.length).toBeGreaterThan(0);
      for (const e of has) expect(e.confidence).toBe('HIGH');
    });

    it('emits RELATES_TO Post→User with HIGH confidence (explicit @relation)', () => {
      const edge = result.relations.find(
        (r) => r.type === 'RELATES_TO'
          && r.sourceId === `table:${REPO}:Post`
          && r.targetId === `table:${REPO}:User`,
      );
      expect(edge).toBeDefined();
      expect(edge!.confidence).toBe('HIGH');
    });

    it('emits MEDIUM-confidence inferred relations (no @relation attr)', () => {
      // User.posts Post[] has no @relation on this side — MEDIUM.
      const edge = result.relations.find(
        (r) => r.type === 'RELATES_TO'
          && r.sourceId === `table:${REPO}:User`
          && r.targetId === `table:${REPO}:Post`,
      );
      expect(edge).toBeDefined();
      expect(edge!.confidence).toBe('MEDIUM');
    });

    it('marks FK columns when @relation fields point to them', () => {
      const fk = findCol(result.columns, 'Post', 'authorId')!;
      expect((fk.properties as { isForeignKey: boolean }).isForeignKey).toBe(true);
    });

    it('records @@index entries', () => {
      const idx = result.indexes.find((i) => i.tableName === 'Post' && i.kind === 'index');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['authorId']);
    });

    it('records @@unique entries', () => {
      const uq = result.indexes.find((i) => i.tableName === 'Tag' && i.kind === 'unique');
      expect(uq).toBeDefined();
      expect(uq!.fields).toEqual(['name']);
    });
  });

  describe('composite primary keys', () => {
    const schema = `
model Membership {
  userId Int
  orgId  Int
  role   String
  @@id([userId, orgId])
}
`;
    const result = extractor.extract(schema, PATH, REPO);

    it('marks composite-id fields as primary', () => {
      const userId = findCol(result.columns, 'Membership', 'userId')!;
      const orgId = findCol(result.columns, 'Membership', 'orgId')!;
      const role = findCol(result.columns, 'Membership', 'role')!;
      expect((userId.properties as { isPrimary: boolean }).isPrimary).toBe(true);
      expect((orgId.properties as { isPrimary: boolean }).isPrimary).toBe(true);
      expect((role.properties as { isPrimary: boolean }).isPrimary).toBe(false);
    });

    it('records the composite @@id as an index of kind id', () => {
      const idx = result.indexes.find((i) => i.kind === 'id' && i.tableName === 'Membership');
      expect(idx).toBeDefined();
      expect(idx!.fields).toEqual(['userId', 'orgId']);
    });
  });

  describe('list fields', () => {
    const schema = `
model Doc {
  id   Int      @id
  tags String[]
}
`;
    it('marks scalar list fields with isList=true', () => {
      const r = extractor.extract(schema, PATH, REPO);
      const tags = findCol(r.columns, 'Doc', 'tags')!;
      expect((tags.properties as { isList: boolean }).isList).toBe(true);
      expect((tags.properties as { type: string }).type).toBe('String');
    });
  });
});
