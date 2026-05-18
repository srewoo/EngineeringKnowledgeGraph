import { describe, it, expect } from 'vitest';
import { KafkaMultiLangExtractor } from '../../src/kafka.multi.parser.js';

describe('KafkaMultiLangExtractor', () => {
  const ex = new KafkaMultiLangExtractor();

  it('extracts Python kafka-python producer + subscribe list', () => {
    const src = [
      'from kafka import KafkaProducer, KafkaConsumer',
      'producer = KafkaProducer()',
      "producer.send('orders.created', value=b'{}')",
      "consumer = KafkaConsumer('orders.created', 'orders.cancelled', group_id='g')",
      "consumer.subscribe(['users.created', \"users.deleted\"])",
      '',
    ].join('\n');
    const r = ex.extract(src, 'python');
    const prods = r.producers.map((p) => p.name).sort();
    const cons = r.consumers.map((c) => c.name).sort();
    expect(prods).toEqual(['orders.created']);
    expect(cons).toContain('users.created');
    expect(cons).toContain('users.deleted');
    expect(cons).toContain('orders.created');
    expect(cons).toContain('orders.cancelled');
  });

  it('extracts Go segmentio writer + reader', () => {
    const src = [
      'package svc',
      'import "github.com/segmentio/kafka-go"',
      'func main() {',
      '    w := kafka.NewWriter(kafka.WriterConfig{ Brokers: []string{}, Topic: "events.audit" })',
      '    _ = w',
      '    r := kafka.NewReader(kafka.ReaderConfig{',
      '        GroupID: "g",',
      '        GroupTopics: []string{"events.audit", "events.security"},',
      '    })',
      '    _ = r',
      '}',
      '',
    ].join('\n');
    const r = ex.extract(src, 'go');
    expect(r.producers.map((p) => p.name)).toContain('events.audit');
    expect(r.consumers.map((c) => c.name).sort()).toEqual(['events.audit', 'events.security']);
  });

  it('extracts Go confluent SubscribeTopics', () => {
    const src = `c.SubscribeTopics([]string{"a","b"}, nil)`;
    const r = ex.extract(src, 'go');
    expect(r.consumers.map((c) => c.name).sort()).toEqual(['a', 'b']);
  });

  it('extracts Java @KafkaListener single topic', () => {
    const src = `
      @Component
      class L {
        @KafkaListener(topics = "billing.events", groupId = "g")
        public void on(String s) {}
      }
    `;
    const r = ex.extract(src, 'java');
    expect(r.consumers[0]!.name).toBe('billing.events');
  });

  it('extracts Java @KafkaListener topics array + KafkaTemplate.send', () => {
    const src = `
      class P {
        @KafkaListener(topics = {"a", "b"})
        void on(String s) {}
        void publish(){
          kafkaTemplate.send("downstream.x", payload);
          new ProducerRecord<>("downstream.y", k, v);
        }
      }
    `;
    const r = ex.extract(src, 'java');
    expect(r.consumers.map((c) => c.name).sort()).toEqual(['a', 'b']);
    expect(r.producers.map((p) => p.name).sort()).toEqual(['downstream.x', 'downstream.y']);
  });
});
