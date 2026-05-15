/**
 * Kafka extractor for TypeScript / JavaScript (Phase 1.5 follow-ups).
 *
 * Walks a ts-morph SourceFile and emits `ParsedKafka { producers, consumers }`:
 *   - `producer.send({ topic: 'X', ... })` (kafkajs / confluent style)
 *   - `consumer.subscribe({ topic: 'X' | topics: ['A','B'] })` (kafkajs)
 *   - `@KafkaListener(topics = "X")` / `@EventPattern('X')` (NestJS)
 *
 * Confidence:
 *   - HIGH for plain string literals
 *   - MEDIUM for template literals (we capture the literal form with `${var}`
 *     placeholders and use a stable `name` derived from collapsing them).
 *
 * Pure / deterministic. No I/O, no LLM.
 */

import { SyntaxKind, type SourceFile, type Node, type ObjectLiteralExpression, type CallExpression } from 'ts-morph';
import type { ParsedKafka, ParsedKafkaTopicRef, ParsedImport } from '@ekg/shared';
import { KAFKA_CLIENT_PACKAGES } from '@ekg/shared';

const PRODUCER_METHODS = new Set(['send', 'sendBatch', 'produce']);
const CONSUMER_METHODS = new Set(['subscribe']);
const NEST_MESSAGE_DECORATORS = new Set([
  'EventPattern', 'MessagePattern', 'KafkaListener',
]);

interface ExtractCtx {
  readonly producers: ParsedKafkaTopicRef[];
  readonly consumers: ParsedKafkaTopicRef[];
  readonly clientLibrary?: string;
}

export class KafkaTypeScriptExtractor {
  /**
   * Extract producer/consumer topic literals. `imports` is used only as a
   * cheap hint for `clientLibrary` annotation — patterns themselves are
   * structural and run regardless.
   */
  extract(source: SourceFile, imports: readonly ParsedImport[]): ParsedKafka {
    const ctx: ExtractCtx = {
      producers: [],
      consumers: [],
      clientLibrary: detectClient(imports),
    };

    for (const call of source.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      this.visitCall(call, ctx);
    }
    this.visitDecorators(source, ctx);

    return { producers: ctx.producers, consumers: ctx.consumers };
  }

  private visitCall(call: CallExpression, ctx: ExtractCtx): void {
    const expr = call.getExpression();
    if (expr.getKind() !== SyntaxKind.PropertyAccessExpression) return;
    const prop = expr.asKind(SyntaxKind.PropertyAccessExpression);
    const methodName = prop?.getName();
    if (!methodName) return;

    const isProducer = PRODUCER_METHODS.has(methodName);
    const isConsumer = CONSUMER_METHODS.has(methodName);
    if (!isProducer && !isConsumer) return;

    const args = call.getArguments();
    if (args.length === 0) return;
    const first = args[0]!;
    if (first.getKind() !== SyntaxKind.ObjectLiteralExpression) return;
    const obj = first.asKind(SyntaxKind.ObjectLiteralExpression);
    if (!obj) return;

    const refs = this.collectFromObjectLiteral(obj, ctx.clientLibrary);
    if (isProducer) ctx.producers.push(...refs);
    else ctx.consumers.push(...refs);
  }

  private collectFromObjectLiteral(
    obj: ObjectLiteralExpression,
    clientLibrary?: string,
  ): readonly ParsedKafkaTopicRef[] {
    const out: ParsedKafkaTopicRef[] = [];
    const topicProp = obj.getProperty('topic');
    const topicsProp = obj.getProperty('topics');

    if (topicProp) {
      const init = topicProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
      const ref = init ? extractTopicLiteral(init, clientLibrary) : undefined;
      if (ref) out.push(ref);
    }
    if (topicsProp) {
      const init = topicsProp.asKind(SyntaxKind.PropertyAssignment)?.getInitializer();
      if (init && init.getKind() === SyntaxKind.ArrayLiteralExpression) {
        const arr = init.asKind(SyntaxKind.ArrayLiteralExpression);
        if (arr) {
          for (const el of arr.getElements()) {
            const ref = extractTopicLiteral(el, clientLibrary);
            if (ref) out.push(ref);
          }
        }
      } else if (init) {
        const ref = extractTopicLiteral(init, clientLibrary);
        if (ref) out.push(ref);
      }
    }
    return out;
  }

  private visitDecorators(source: SourceFile, ctx: ExtractCtx): void {
    for (const cls of source.getClasses()) {
      for (const m of cls.getMethods()) {
        for (const dec of m.getDecorators()) {
          if (!NEST_MESSAGE_DECORATORS.has(dec.getName())) continue;
          const args = dec.getArguments();
          for (const a of args) {
            const ref = extractTopicLiteral(a, ctx.clientLibrary);
            if (ref) ctx.consumers.push(ref);
          }
        }
      }
    }
  }
}

function detectClient(imports: readonly ParsedImport[]): string | undefined {
  for (const imp of imports) {
    if (KAFKA_CLIENT_PACKAGES.includes(imp.source)) return imp.source;
  }
  return undefined;
}

/**
 * Pull the topic name out of an AST node. Returns `undefined` for anything
 * we can't statically resolve (e.g. a bare identifier `topic: TOPIC`). Plain
 * string → HIGH confidence. Template literal with ${...} → MEDIUM, name is
 * the template form with `{var}` placeholders preserved.
 */
function extractTopicLiteral(
  node: Node,
  clientLibrary?: string,
): ParsedKafkaTopicRef | undefined {
  const kind = node.getKind();
  const sourceLine = node.getStartLineNumber();

  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const raw = node.getText().slice(1, -1);
    if (!raw) return undefined;
    const ref: ParsedKafkaTopicRef = {
      name: raw,
      sourceLine,
      confidence: 'HIGH',
      ...(clientLibrary ? { clientLibrary } : {}),
    };
    return ref;
  }

  if (kind === SyntaxKind.TemplateExpression) {
    const raw = node.getText().slice(1, -1);
    const collapsed = raw.replace(/\$\{[^}]*\}/g, '{var}');
    if (!collapsed || collapsed === '{var}') return undefined;
    return {
      name: collapsed,
      template: raw,
      sourceLine,
      confidence: 'MEDIUM',
      ...(clientLibrary ? { clientLibrary } : {}),
    };
  }

  return undefined;
}
