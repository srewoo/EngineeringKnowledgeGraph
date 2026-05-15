/**
 * LLM completion provider contract for the agent loop.
 *
 * Distinct from `@ekg/embeddings` (vectorisation) and `@ekg/router` (single-shot
 * classification). This interface supports tool-using completions: the model
 * can decide to call EKG tools mid-loop and receive their results.
 *
 * Implementations are pure adapters around HTTP APIs — no SDKs.
 */

export type LlmProviderId = 'openai' | 'anthropic' | 'ollama';

export type Role = 'user' | 'assistant' | 'tool';

export interface TextMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ToolResultMessage {
  readonly role: 'tool';
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string; // JSON-stringified or plain text result
  readonly isError?: boolean;
}

export type Message = TextMessage | ToolResultMessage;

export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  /** JSON-schema-shaped object describing the tool input. */
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'error';

export interface CompletionRequest {
  readonly system: string;
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSpec[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
}

export interface CompletionResponse {
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly stopReason: StopReason;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}
