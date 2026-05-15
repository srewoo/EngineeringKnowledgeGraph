/**
 * Ollama chat provider with tool-calling. Raw fetch — no SDK.
 *
 * Tool support requires a tool-capable local model (llama3.1+, qwen2.5+, etc.).
 * Ollama's response shape mirrors OpenAI: message.tool_calls[].function.{name,arguments}.
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

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 0.2;

export interface OllamaProviderOptions {
  readonly baseUrl?: string;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
}

interface OllamaToolCall {
  readonly function?: { readonly name?: string; readonly arguments?: unknown };
}

interface OllamaResponse {
  readonly message?: {
    readonly content?: string;
    readonly tool_calls?: readonly OllamaToolCall[];
  };
  readonly done_reason?: string;
  readonly prompt_eval_count?: number;
  readonly eval_count?: number;
}

export class OllamaProvider implements LlmProvider {
  readonly id = 'ollama' as const;
  readonly model: string;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger;

  constructor(opts: OllamaProviderOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env['OLLAMA_URL'] ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
    this.model = opts.model ?? 'llama3.1:8b';
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.logger = createLogger({ service: 'ollama-agent-provider' });
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const body = {
      model: this.model,
      stream: false,
      options: {
        num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
        ...(req.stopSequences && req.stopSequences.length > 0 ? { stop: req.stopSequences } : {}),
      },
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map(toOllamaMessage),
      ],
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };

    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`Ollama completion ${res.status}: ${txt}`);
    }
    const json = (await res.json()) as OllamaResponse;
    const toolCalls: ToolCall[] = (json.message?.tool_calls ?? []).map((tc, idx) => ({
      id: `ollama-tc-${idx}`,
      name: tc.function?.name ?? '',
      arguments: normaliseArgs(tc.function?.arguments),
    })).filter((tc) => tc.name);

    this.logger.debug(
      { eval: json.eval_count, tools: toolCalls.length },
      'Ollama completion done',
    );
    return {
      content: json.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: json.prompt_eval_count ?? 0,
        outputTokens: json.eval_count ?? 0,
      },
      stopReason: toolCalls.length > 0 ? 'tool_use' : mapStopReason(json.done_reason),
    };
  }

  async *completeStream(req: CompletionRequest): AsyncIterable<CompletionDelta> {
    const body = {
      model: this.model,
      stream: true,
      options: {
        num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: req.temperature ?? DEFAULT_TEMPERATURE,
      },
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map(toOllamaMessage),
      ],
      ...(req.tools && req.tools.length > 0
        ? {
            tools: req.tools.map((t) => ({
              type: 'function' as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
    };
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) {
      const txt = await safeText(res);
      throw new Error(`Ollama stream ${res.status}: ${txt}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let stop: StopReason | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    const calls: ToolCall[] = [];
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let chunk: OllamaResponse;
          try { chunk = JSON.parse(line) as OllamaResponse; } catch { continue; }
          if (chunk.message?.content) yield { textDelta: chunk.message.content };
          if (chunk.message?.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const call: ToolCall = {
                id: `ollama-tc-${calls.length}`,
                name: tc.function?.name ?? '',
                arguments: normaliseArgs(tc.function?.arguments),
              };
              if (call.name) calls.push(call);
            }
          }
          if (chunk.done_reason) stop = mapStopReason(chunk.done_reason);
          if (chunk.prompt_eval_count) inputTokens = chunk.prompt_eval_count;
          if (chunk.eval_count) outputTokens = chunk.eval_count;
        }
      }
    } finally {
      reader.releaseLock();
    }
    for (const call of calls) {
      yield { toolCallStart: call };
      yield { toolCallEnd: { id: call.id } };
    }
    yield { usage: { inputTokens, outputTokens } };
    yield { stopReason: calls.length > 0 ? 'tool_use' : (stop ?? 'end_turn') };
  }
}

function toOllamaMessage(m: Message): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content };
  }
  return { role: m.role, content: m.content };
}

function normaliseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch { return {}; }
  }
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

function mapStopReason(reason: string | undefined): StopReason {
  if (reason === 'length') return 'max_tokens';
  if (reason === 'stop' || reason === undefined) return 'end_turn';
  return 'end_turn';
}

async function safeText(r: Response): Promise<string> {
  try { return await r.text(); } catch { return '<no-body>'; }
}
