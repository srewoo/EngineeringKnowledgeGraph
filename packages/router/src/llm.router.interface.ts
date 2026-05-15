/**
 * Contract for LLM-backed question routers. Pure adapters around an HTTP API.
 * Implementations must validate the response with Zod and reject malformed JSON.
 */

import type { QuestionClass } from './question.classifier.js';

export interface LlmClassification {
  readonly class: QuestionClass;
  readonly confidence: number;
  readonly reasoning: string;
}

export interface LlmRouter {
  readonly id: 'openai' | 'anthropic' | 'ollama';
  readonly model: string;
  classify(question: string): Promise<LlmClassification>;
}
