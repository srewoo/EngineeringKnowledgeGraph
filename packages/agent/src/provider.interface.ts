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

export interface CompletionDelta {
  /** Incremental assistant text. */
  readonly textDelta?: string;
  /** A new tool call has started; full call shape (we don't stream argument deltas at this layer). */
  readonly toolCallStart?: ToolCall;
  /** Optional incremental argument text for a previously-started tool call. */
  readonly toolCallDelta?: { readonly id: string; readonly argDelta: string };
  /** A tool call has completed (provider signalled the end of its argument stream). */
  readonly toolCallEnd?: { readonly id: string };
  /** Token-usage update. */
  readonly usage?: Partial<{ inputTokens: number; outputTokens: number }>;
  /** Final stop reason — emitted at most once. */
  readonly stopReason?: StopReason;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  readonly model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
  /**
   * Optional streaming variant. Yields deltas as they arrive. Implementations
   * MUST yield exactly one final delta carrying `stopReason` (and ideally
   * final `usage`). For simplicity, we treat tool calls as atomic — yield
   * `toolCallStart` once with the full ToolCall when complete.
   */
  completeStream?(req: CompletionRequest): AsyncIterable<CompletionDelta>;
}
