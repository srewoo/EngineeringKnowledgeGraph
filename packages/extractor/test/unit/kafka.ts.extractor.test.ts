import { describe, it, expect } from 'vitest';
import { Project } from 'ts-morph';
import { KafkaTypeScriptExtractor } from '@ekg/parser';
import type { ParsedImport } from '@ekg/shared';

function parse(src: string): { sf: import('ts-morph').SourceFile; imports: ParsedImport[] } {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile('test.ts', src);
  const imports: ParsedImport[] = [];
  for (const decl of sf.getImportDeclarations()) {
    imports.push({
      source: decl.getModuleSpecifierValue(),
      specifiers: decl.getNamedImports().map((n) => n.getName()),
      isTypeOnly: decl.isTypeOnly(),
      isLocal: decl.getModuleSpecifierValue().startsWith('.'),
    });
  }
  return { sf, imports };
}

describe('KafkaTypeScriptExtractor', () => {
  const extractor = new KafkaTypeScriptExtractor();

  it('captures kafkajs producer.send literal topic', () => {
    const { sf, imports } = parse(`
      import { Kafka } from 'kafkajs';
      const k = new Kafka({});
      const producer = k.producer();
      await producer.send({ topic: 'orders.created', messages: [{ value: 'x' }] });
    `);
    const out = extractor.extract(sf, imports);
    expect(out.producers.length).toBe(1);
    expect(out.producers[0]?.name).toBe('orders.created');
    expect(out.producers[0]?.confidence).toBe('HIGH');
    expect(out.producers[0]?.clientLibrary).toBe('kafkajs');
  });

  it('captures consumer.subscribe topics array (multi-topic)', () => {
    const { sf, imports } = parse(`
      import { Kafka } from 'kafkajs';
      const consumer = new Kafka({}).consumer({ groupId: 'g' });
      await consumer.subscribe({ topics: ['orders.created', 'orders.updated'], fromBeginning: true });
    `);
    const out = extractor.extract(sf, imports);
    const names = out.consumers.map((c) => c.name).sort();
    expect(names).toEqual(['orders.created', 'orders.updated']);
  });

  it('captures NestJS @EventPattern decorator', () => {
    const { sf, imports } = parse(`
      class C {
        @EventPattern('billing.charged')
        handle(payload: unknown) {}
      }
    `);
    const out = extractor.extract(sf, imports);
    expect(out.consumers.length).toBe(1);
    expect(out.consumers[0]?.name).toBe('billing.charged');
  });

  it('marks template-literal topic as MEDIUM with template preserved', () => {
    const { sf, imports } = parse(`
      const env = 'staging';
      const producer = {} as any;
      producer.send({ topic: \`orders.\${env}.created\`, messages: [] });
    `);
    const out = extractor.extract(sf, imports);
    expect(out.producers.length).toBe(1);
    expect(out.producers[0]?.confidence).toBe('MEDIUM');
    expect(out.producers[0]?.name).toBe('orders.{var}.created');
    expect(out.producers[0]?.template).toBe('orders.${env}.created');
  });

  it('returns empty when no kafka calls present', () => {
    const { sf, imports } = parse(`const x = 1;`);
    const out = extractor.extract(sf, imports);
    expect(out.producers.length).toBe(0);
    expect(out.consumers.length).toBe(0);
  });
});
