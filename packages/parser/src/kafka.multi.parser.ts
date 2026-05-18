/**
 * Kafka extractor for non-TS languages — Python, Go, Java/Kotlin.
 *
 * Patterns covered:
 *  - Python (kafka-python, confluent-kafka, aiokafka):
 *      `producer.send("topic", ...)`
 *      `producer.produce("topic", ...)`
 *      `consumer.subscribe(["a","b"])` / `subscribe("a")`
 *      `KafkaConsumer("a","b", ...)`
 *  - Go (Sarama, segmentio/kafka-go, confluent-kafka-go):
 *      `kafka.Message{Topic: "a"}`
 *      `kafka.Writer{Topic: "a"}`
 *      `kafka.NewReader(kafka.ReaderConfig{Topic: "a", GroupTopics: []string{"b","c"}})`
 *      `producer.Produce(&kafka.Message{ TopicPartition: kafka.TopicPartition{ Topic: &topic } })`
 *      `consumer.SubscribeTopics([]string{"a","b"}, nil)`
 *  - Java / Kotlin / Spring:
 *      `@KafkaListener(topics = "a")` / `topics = {"a","b"}`
 *      `kafkaTemplate.send("a", ...)`
 *      `new ProducerRecord<>("a", key, value)`
 *
 * Returns ParsedKafka — same shape as the TS extractor — so the pipeline can
 * consume both uniformly.
 */

import type { ParsedKafka, ParsedKafkaTopicRef } from '@ekg/shared';

export type KafkaMultiLang = 'python' | 'go' | 'java' | 'kotlin' | 'scala';

const EXT_TO_LANG: Readonly<Record<string, KafkaMultiLang>> = {
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
};

export class KafkaMultiLangExtractor {
  static handles(extension: string): boolean {
    return extension.toLowerCase() in EXT_TO_LANG;
  }

  static detectLanguage(extension: string): KafkaMultiLang | undefined {
    return EXT_TO_LANG[extension.toLowerCase()];
  }

  extract(content: string, language: KafkaMultiLang): ParsedKafka {
    if (language === 'python') return extractPython(content);
    if (language === 'go') return extractGo(content);
    return extractJvm(content);
  }
}

// --- Python ---

const PY_PRODUCER_RE =
  /\b(?:[A-Za-z_][\w]*\.)?(?:send|produce)\s*\(\s*(["'])([^"']+)\1/g;
const PY_SUBSCRIBE_LIST_RE =
  /\bsubscribe\s*\(\s*\[([^\]]+)\]/g;
const PY_SUBSCRIBE_STR_RE =
  /\bsubscribe\s*\(\s*(["'])([^"']+)\1/g;
const PY_KAFKA_CONSUMER_RE =
  /\bKafkaConsumer\s*\(\s*((?:["'][^"']+["']\s*,?\s*)+)/g;

function extractPython(content: string): ParsedKafka {
  const producers: ParsedKafkaTopicRef[] = [];
  const consumers: ParsedKafkaTopicRef[] = [];

  // Producers: only count send/produce when the receiver looks producer-ish.
  let m: RegExpExecArray | null;
  PY_PRODUCER_RE.lastIndex = 0;
  while ((m = PY_PRODUCER_RE.exec(content))) {
    // Heuristic guard — skip when method is .subscribe.send (rare); accept all here.
    producers.push({
      name: m[2]!,
      sourceLine: lineOf(content, m.index),
      confidence: 'HIGH',
      clientLibrary: 'kafka-python',
    });
  }

  PY_SUBSCRIBE_LIST_RE.lastIndex = 0;
  while ((m = PY_SUBSCRIBE_LIST_RE.exec(content))) {
    for (const t of stringList(m[1] ?? '')) {
      consumers.push({
        name: t,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'kafka-python',
      });
    }
  }
  PY_SUBSCRIBE_STR_RE.lastIndex = 0;
  while ((m = PY_SUBSCRIBE_STR_RE.exec(content))) {
    consumers.push({
      name: m[2]!,
      sourceLine: lineOf(content, m.index),
      confidence: 'HIGH',
      clientLibrary: 'kafka-python',
    });
  }
  PY_KAFKA_CONSUMER_RE.lastIndex = 0;
  while ((m = PY_KAFKA_CONSUMER_RE.exec(content))) {
    for (const t of stringList(m[1] ?? '')) {
      consumers.push({
        name: t,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'kafka-python',
      });
    }
  }

  return { producers, consumers };
}

// --- Go ---

const GO_TOPIC_FIELD_RE =
  /\bTopic\s*:\s*(?:&\s*[A-Za-z_][\w]*|"([^"]+)")/g;
const GO_TOPIC_VAR_DECL_RE =
  /\b([A-Za-z_][\w]*)\s*(?::=|=)\s*"([^"]+)"\s*$/gm;
const GO_SUBSCRIBE_TOPICS_RE =
  /\bSubscribeTopics\s*\(\s*\[\]string\s*\{([^}]+)\}/g;
const GO_GROUPTOPICS_RE =
  /\bGroupTopics\s*:\s*\[\]string\s*\{([^}]+)\}/g;

function extractGo(content: string): ParsedKafka {
  const producers: ParsedKafkaTopicRef[] = [];
  const consumers: ParsedKafkaTopicRef[] = [];

  // Build a small symbol table of `var := "topic"` so `Topic: &varname` resolves.
  const varMap = new Map<string, string>();
  let m: RegExpExecArray | null;
  GO_TOPIC_VAR_DECL_RE.lastIndex = 0;
  while ((m = GO_TOPIC_VAR_DECL_RE.exec(content))) {
    varMap.set(m[1]!, m[2]!);
  }

  // Topic fields — appear in both producer (Writer) and consumer (Reader/Config) constructions.
  // We classify by scanning a small window around the match.
  GO_TOPIC_FIELD_RE.lastIndex = 0;
  while ((m = GO_TOPIC_FIELD_RE.exec(content))) {
    const literal = m[1];
    const ampMatch = /Topic\s*:\s*&\s*([A-Za-z_][\w]*)/.exec(m[0]);
    const name = literal ?? (ampMatch ? varMap.get(ampMatch[1]!) : undefined);
    if (!name) continue;
    const window = content.slice(Math.max(0, m.index - 200), m.index);
    const isReader = /\bReader|GroupID|GroupTopics|kafka\.NewReader|consumer/i.test(window);
    const ref: ParsedKafkaTopicRef = {
      name,
      sourceLine: lineOf(content, m.index),
      confidence: literal ? 'HIGH' : 'MEDIUM',
      clientLibrary: 'kafka-go',
    };
    (isReader ? consumers : producers).push(ref);
  }

  GO_SUBSCRIBE_TOPICS_RE.lastIndex = 0;
  while ((m = GO_SUBSCRIBE_TOPICS_RE.exec(content))) {
    for (const t of stringList(m[1] ?? '')) {
      consumers.push({
        name: t,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'confluent-kafka-go',
      });
    }
  }
  GO_GROUPTOPICS_RE.lastIndex = 0;
  while ((m = GO_GROUPTOPICS_RE.exec(content))) {
    for (const t of stringList(m[1] ?? '')) {
      consumers.push({
        name: t,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'kafka-go',
      });
    }
  }

  return { producers, consumers };
}

// --- Java / Kotlin / Scala ---

const JVM_KAFKA_LISTENER_RE =
  /@KafkaListener\s*\(\s*[^)]*?topics\s*=\s*(?:"([^"]+)"|\{\s*([^}]+)\s*\})/g;
const JVM_KAFKA_TEMPLATE_SEND_RE =
  /\bkafkaTemplate\.send\s*\(\s*"([^"]+)"/g;
const JVM_PRODUCER_RECORD_RE =
  /\bnew\s+ProducerRecord\s*<[^>]*>\s*\(\s*"([^"]+)"/g;
const JVM_PRODUCER_RECORD_KT_RE =
  /\bProducerRecord\s*\(\s*"([^"]+)"/g;
const JVM_CONSUMER_SUBSCRIBE_RE =
  /\.subscribe\s*\(\s*(?:Arrays\.asList|List\.of|listOf)\s*\(\s*([^)]+)\)/g;

function extractJvm(content: string): ParsedKafka {
  const producers: ParsedKafkaTopicRef[] = [];
  const consumers: ParsedKafkaTopicRef[] = [];

  let m: RegExpExecArray | null;
  JVM_KAFKA_LISTENER_RE.lastIndex = 0;
  while ((m = JVM_KAFKA_LISTENER_RE.exec(content))) {
    const single = m[1];
    if (single) {
      consumers.push({
        name: single,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'spring-kafka',
      });
    } else if (m[2]) {
      for (const t of stringList(m[2])) {
        consumers.push({
          name: t,
          sourceLine: lineOf(content, m.index),
          confidence: 'HIGH',
          clientLibrary: 'spring-kafka',
        });
      }
    }
  }

  JVM_KAFKA_TEMPLATE_SEND_RE.lastIndex = 0;
  while ((m = JVM_KAFKA_TEMPLATE_SEND_RE.exec(content))) {
    producers.push({
      name: m[1]!,
      sourceLine: lineOf(content, m.index),
      confidence: 'HIGH',
      clientLibrary: 'spring-kafka',
    });
  }
  JVM_PRODUCER_RECORD_RE.lastIndex = 0;
  while ((m = JVM_PRODUCER_RECORD_RE.exec(content))) {
    producers.push({
      name: m[1]!,
      sourceLine: lineOf(content, m.index),
      confidence: 'HIGH',
      clientLibrary: 'kafka-clients',
    });
  }
  JVM_PRODUCER_RECORD_KT_RE.lastIndex = 0;
  while ((m = JVM_PRODUCER_RECORD_KT_RE.exec(content))) {
    // Skip duplicates already captured by the Java variant above.
    if (producers.some((p) => p.name === m![1]! && p.sourceLine === lineOf(content, m!.index))) continue;
    producers.push({
      name: m[1]!,
      sourceLine: lineOf(content, m.index),
      confidence: 'HIGH',
      clientLibrary: 'kafka-clients',
    });
  }
  JVM_CONSUMER_SUBSCRIBE_RE.lastIndex = 0;
  while ((m = JVM_CONSUMER_SUBSCRIBE_RE.exec(content))) {
    for (const t of stringList(m[1] ?? '')) {
      consumers.push({
        name: t,
        sourceLine: lineOf(content, m.index),
        confidence: 'HIGH',
        clientLibrary: 'kafka-clients',
      });
    }
  }

  return { producers, consumers };
}

// --- helpers ---

function stringList(raw: string): readonly string[] {
  // Extract `"a"`, `'b'` (Python) or "`a`" (no — no backticks in Java/Go); split on commas.
  const out: string[] = [];
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) out.push(m[1]!);
  return out;
}

function lineOf(content: string, idx: number): number {
  let n = 1;
  for (let i = 0; i < idx && i < content.length; i++) {
    if (content[i] === '\n') n++;
  }
  return n;
}
