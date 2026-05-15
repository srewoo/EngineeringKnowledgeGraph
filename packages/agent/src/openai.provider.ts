/**
 * OpenAI Chat Completions provider with tool-calling. Raw fetch — no SDK.
 *
 * Maps EKG's neutral Message/ToolCall types to OpenAI's
 * { role, content, tool_calls } / { role: 'tool', tool_call_id } shapes.
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

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly endpoint?: string;
  readonly fetchImpl?: typeof fetch;
}

interface OpenAIToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAIChoice {
  readonly message?: {
    readonly content?: string | null;
    readonly tool_calls?: readonly OpenAIToolCall[];
  };
  readonly finish_reason?: string;
}

interface OpenAIResponse {
  readonly choices?: readonly OpenAIChoice[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
}

export class OpenAIProvider implements LlmProvider {
  readonly id = 'openai' as const;
  readonly model: string;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OpenAIProviderOptions) {
    if (!opts.apiKey) throw new Error('OpenAIProvider: apiKey required');
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gpt-4o-mini';
    this.endpoint = opts.endpoint ?? ENDPOINT;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'openai-agent-provider' });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map(toOpenAIMessage),
      ],
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
      ...(req.stopSequences && req.stopSequences.length > 0 ? { stop: req.stopSequences } : {}),
    };

    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`OpenAI completion ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as OpenAIResponse;
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: parseArgs(tc.function.arguments),
    }));
    this.logger.debug({ tokens: json.usage, tools: toolCalls.length }, 'OpenAI completion done');
    return {
      content: msg?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
      stopReason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
    };
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<CompletionDelta> {
    const body = {
      model: this.model,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
      temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map(toOpenAIMessage),
      ],
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
            tool_choice: 'auto' as const,
          }
        : {}),
    };
    const res = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = await safeText(res);
      throw new Error(`OpenAI stream ${res.status}: ${txt}`);
    }
    const toolBuf = new Map<number, { id: string; name: string; args: string }>();
    let stop: StopReason | undefined;
    for await (const evt of readSse(res.body)) {
      if (evt.data === '[DONE]') break;
      let chunk: OpenAIStreamChunk;
      try { chunk = JSON.parse(evt.data) as OpenAIStreamChunk; } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      if (delta?.content) yield { textDelta: delta.content };
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const slot = toolBuf.get(tc.index) ?? { id: tc.id ?? `tc-${tc.index}`, name: '', args: '' };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments;
            yield { toolCallDelta: { id: slot.id, argDelta: tc.function.arguments } };
          }
          toolBuf.set(tc.index, slot);
        }
      }
      const finish = chunk.choices?.[0]?.finish_reason;
      if (finish) stop = mapStopReason(finish, toolBuf.size > 0);
      if (chunk.usage) yield { usage: { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens } };
    }
    for (const slot of toolBuf.values()) {
      const call: ToolCall = { id: slot.id, name: slot.name, arguments: parseArgs(slot.args) };
      yield { toolCallStart: call };
      yield { toolCallEnd: { id: slot.id } };
    }
    yield { stopReason: stop ?? (toolBuf.size > 0 ? 'tool_use' : 'end_turn') };
  }
}

interface OpenAIStreamChunk {
  readonly choices?: ReadonlyArray<{
    readonly delta?: {
      readonly content?: string;
      readonly tool_calls?: ReadonlyArray<{
        readonly index: number;
        readonly id?: string;
        readonly function?: { readonly name?: string; readonly arguments?: string };
      }>;
    };
    readonly finish_reason?: string;
  }>;
  readonly usage?: { readonly prompt_tokens: number; readonly completion_tokens: number };
}

function toOpenAIMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  return { role: m.role, content: m.content };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapStopReason(reason: string | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop' || reason === 'end_turn') return 'end_turn';
  if (!reason) return 'end_turn';
  return 'error';
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
