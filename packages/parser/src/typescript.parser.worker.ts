/**
 * Worker-thread entry: parses TS/JS files in a separate Node thread.
 *
 * Protocol (parentPort messages):
 *   IN:  { id: number, filePath: string }
 *   OUT: { id: number, ok: true, result: ParseResult }
 *      | { id: number, ok: false, error: string }
 *
 * Each worker holds a single TypeScriptParser (= one ts-morph Project) and
 * reuses it across files for cache locality.
 */

import { parentPort } from 'node:worker_threads';
import { TypeScriptParser } from './typescript.parser.js';

if (!parentPort) {
  throw new Error('typescript.parser.worker: must be loaded as a worker thread');
}

const parser = new TypeScriptParser();

parentPort.on('message', (msg: { id: number; filePath: string }) => {
  try {
    const result = parser.parseFile(msg.filePath);
    parentPort!.postMessage({ id: msg.id, ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    parentPort!.postMessage({ id: msg.id, ok: false, error: message });
  }
});
