/**
 * Tiny SSE line parser for streaming LLM endpoints (OpenAI, Anthropic).
 *
 * Reads a fetch ReadableStream<Uint8Array>, yields events of the form
 * `{ event?: string; data: string }`. Caller is responsible for JSON parsing
 * and `[DONE]` handling.
 */

export interface SseEvent {
  readonly event?: string;
  readonly data: string;
}

export async function* readSse(stream: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const evt = parseEvent(raw);
        if (evt) yield evt;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SseEvent | undefined {
  if (!raw.trim()) return undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue; // comment
    if (line.startsWith('event:')) {
      event = line.slice(6).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return undefined;
  return event !== undefined ? { event, data: dataLines.join('\n') } : { data: dataLines.join('\n') };
}
