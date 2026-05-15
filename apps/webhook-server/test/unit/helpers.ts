/**
 * Test helpers — synthesise IncomingMessage / ServerResponse pairs without
 * binding a real port. Lets us exercise the handler logic with fast unit
 * tests.
 */

import { Readable, Writable } from 'node:stream';
import { Socket } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface CapturedResponse {
  status?: number;
  headers: Record<string, string | number>;
  body: string;
}

export function makeRequest(opts: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(opts.body ?? '', 'utf8')]) as unknown as IncomingMessage;
  // Patch in the IncomingMessage shape Node consumers expect.
  Object.assign(stream, {
    method: opts.method,
    url: opts.url,
    headers: lowercaseHeaders(opts.headers ?? {}),
    socket: new Socket(),
  });
  return stream;
}

export function makeResponse(captured: CapturedResponse): ServerResponse {
  const sink = new Writable({
    write(_chunk: Buffer, _enc, cb) { cb(); },
  });
  const res = sink as unknown as ServerResponse & {
    writeHead: (s: number, h: Record<string, string | number>) => ServerResponse;
    end: (b?: string) => void;
  };
  res.writeHead = (status: number, headers: Record<string, string | number>): ServerResponse => {
    captured.status = status;
    captured.headers = { ...captured.headers, ...headers };
    return res;
  };
  res.end = (body?: string) => { captured.body = body ?? ''; };
  return res as unknown as ServerResponse;
}

function lowercaseHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}
