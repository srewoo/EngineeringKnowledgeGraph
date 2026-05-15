/**
 * Anthropic Messages API provider with tool-calling. Raw fetch — no SDK.
 *
 * Anthropic represents tool calls as content blocks of type=tool_use, and
 * tool results as content blocks of type=tool_result inside a user message.
 */

import { createLogger, type Logger } from '@ekg/shared';
import type {
  LlmProvider,
  CompletionRequest,
  CompletionResponse,
  CompletionDelta,
  Message,
  ToolCall,
  StopReason,
} from './provider.interface.js';
import { readSse } from './sse.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

interface ContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

interface MessagesResponse {
  readonly content?: readonly ContentBlock[];
  readonly stop_reason?: string;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: AnthropicProviderOptions) {
    if (!opts.apiKey) throw new Error('AnthropicProvider: apiKey required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'claude-3-5-sonnet-latest';
    this.endpoint = opts.endpoint ?? ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'anthropic-agent-provider' });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema,
            })),
          }
        : {}),
      ...(req.stopSequences && req.stopSequences.length > 0
        ? { stop_sequences: req.stopSequences }
        : {}),
    };

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`Anthropic completion ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as MessagesResponse;

    const text = (json.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text ?? '')
      .join('');
    const toolCalls: ToolCall[] = (json.content ?? [])
      .filter((b) => b.type === 'tool_use' && b.id && b.name)
      .map((b) => ({
        id: b.id ?? '',
        name: b.name ?? '',
        arguments: (b.input ?? {}) as Record<string, unknown>,
      }));

    this.logger.debug({ tokens: json.usage, tools: toolCalls.length }, 'Anthropic completion done');
    return {
      content: text,
      toolCalls,
      usage: {
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
      },
      stopReason: mapStopReason(json.stop_reason),
    };
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<CompletionDelta> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      stream: true,
      system: req.system,
      messages: req.messages.map(toAnthropicMessage),
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              name: t.name, description: t.description, input_schema: t.inputSchema,
            })),
          }
        : {}),
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = await safeText(res);
      throw new Error(`Anthropic stream ${res.status}: ${txt}`);
    }
    const blocks = new Map<number, { type: string; id?: string; name?: string; argsBuf: string }>();
    let stop: StopReason | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    for await (const evt of readSse(res.body)) {
      let payload: AnthropicStreamEvent;
      try { payload = JSON.parse(evt.data) as AnthropicStreamEvent; } catch { continue; }
      const t = payload.type;
      if (t === 'message_start' && payload.message?.usage) {
        inputTokens = payload.message.usage.input_tokens ?? 0;
      } else if (t === 'content_block_start' && typeof payload.index === 'number' && payload.content_block) {
        const cb = payload.content_block;
        blocks.set(payload.index, { type: cb.type, id: cb.id, name: cb.name, argsBuf: '' });
      } else if (t === 'content_block_delta' && typeof payload.index === 'number' && payload.delta) {
        const slot = blocks.get(payload.index);
        if (!slot) continue;
        if (payload.delta.type === 'text_delta' && payload.delta.text) {
          yield { textDelta: payload.delta.text };
        } else if (payload.delta.type === 'input_json_delta' && payload.delta.partial_json) {
          slot.argsBuf += payload.delta.partial_json;
          if (slot.id) yield { toolCallDelta: { id: slot.id, argDelta: payload.delta.partial_json } };
        }
      } else if (t === 'content_block_stop' && typeof payload.index === 'number') {
        const slot = blocks.get(payload.index);
        if (slot && slot.type === 'tool_use' && slot.id && slot.name) {
          let parsedArgs: Record<string, unknown> = {};
          try { parsedArgs = slot.argsBuf ? (JSON.parse(slot.argsBuf) as Record<string, unknown>) : {}; } catch { /* keep empty */ }
          const call: ToolCall = { id: slot.id, name: slot.name, arguments: parsedArgs };
          yield { toolCallStart: call };
          yield { toolCallEnd: { id: slot.id } };
        }
      } else if (t === 'message_delta') {
        if (payload.delta?.stop_reason) stop = mapStopReason(payload.delta.stop_reason);
        if (payload.usage?.output_tokens) outputTokens = payload.usage.output_tokens;
      } else if (t === 'message_stop') {
        // emit final usage
      }
    }
    yield { usage: { inputTokens, outputTokens } };
    yield { stopReason: stop ?? 'end_turn' };
  }
}

interface AnthropicStreamEvent {
  readonly type: string;
  readonly index?: number;
  readonly message?: { readonly usage?: { readonly input_tokens?: number } };
  readonly content_block?: { readonly type: string; readonly id?: string; readonly name?: string };
  readonly delta?: {
    readonly type?: string;
    readonly text?: string;
    readonly partial_json?: string;
    readonly stop_reason?: string;
  };
  readonly usage?: { readonly output_tokens?: number };
}

function toAnthropicMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: m.content,
          ...(m.isError ? { is_error: true } : {}),
        },
      ],
    };
  }
  return { role: m.role, content: m.content };
}

function mapStopReason(reason: string | undefined): StopReason {
  switch (reason) {
    case 'tool_use': return 'tool_use';
    case 'end_turn': return 'end_turn';
    case 'max_tokens': return 'max_tokens';
    case undefined: return 'end_turn';
    default: return 'error';
  }
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
