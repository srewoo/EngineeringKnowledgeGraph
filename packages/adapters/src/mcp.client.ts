/**
 * Mcp stdio client — thin wrapper around `@modelcontextprotocol/sdk`'s
 * StdioClientTransport + Client.
 *
 * Adapters that wrap external MCP servers (Atlassian, Mixpanel, Loki, ...)
 * spawn the server via `command + args` and then call its exposed tools
 * via JSON-RPC. We hide the SDK behind a tiny surface so adapters only need
 * `connect()`, `callTool(name, args)`, and `disconnect()`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLogger, type Logger } from '@ekg/shared';

export interface McpStdioOptions {
  /** e.g. "npx" — the executable to spawn. */
  readonly command: string;
  /** e.g. ["-y", "@atlassian/mcp-server"]. */
  readonly args?: readonly string[];
  /** Extra env vars merged onto `process.env` for the spawned server. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Working directory for the spawned process. */
  readonly cwd?: string;
  /** Per-request timeout (ms). Defaults to 30s. */
  readonly callTimeoutMs?: number;
  /** Logger; defaults to a fresh `mcp-client` logger. */
  readonly logger?: Logger;
}

export interface CallToolResult {
  readonly raw: unknown;
  readonly content: readonly { type: string; text?: string }[];
  readonly isError: boolean;
}

/**
 * Default to "command + args" parsing if a single combined `command` string
 * is provided (e.g. config gives `"npx -y @atlassian/mcp-server"`). Quoting
 * is intentionally minimal — split on whitespace.
 */
export function splitCommand(combined: string): { command: string; args: string[] } {
  const parts = combined.trim().split(/\s+/).filter((s) => s.length > 0);
  if (parts.length === 0) throw new Error('empty command');
  return { command: parts[0]!, args: parts.slice(1) };
}

export class McpStdioClient {
  private readonly opts: Required<Pick<McpStdioOptions, 'command' | 'callTimeoutMs'>> & McpStdioOptions;
  private readonly logger: Logger;
  private client?: Client;
  private transport?: StdioClientTransport;
  private childProc?: ChildProcess;

  constructor(opts: McpStdioOptions) {
    this.opts = {
      callTimeoutMs: 30_000,
      ...opts,
    };
    this.logger = opts.logger ?? createLogger({ service: 'mcp-client' });
  }

  async connect(clientName = 'ekg-adapters', clientVersion = '0.1.0'): Promise<void> {
    if (this.client) return;
    const cleanedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.opts.env ?? {})) {
      if (typeof v === 'string') cleanedEnv[k] = v;
    }
    const transport = new StdioClientTransport({
      command: this.opts.command,
      args: [...(this.opts.args ?? [])],
      env: { ...(process.env as Record<string, string>), ...cleanedEnv },
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
    });
    const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });
    await client.connect(transport);
    this.client = client;
    this.transport = transport;
    this.logger.info({ command: this.opts.command }, 'mcp client connected');
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    if (!this.client) throw new Error('mcp client not connected');
    const t0 = Date.now();
    const res = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.opts.callTimeoutMs },
    );
    this.logger.debug({ tool: name, durationMs: Date.now() - t0 }, 'mcp tool call');
    const content = Array.isArray((res as Record<string, unknown>)['content'])
      ? ((res as Record<string, unknown>)['content'] as { type: string; text?: string }[])
      : [];
    return {
      raw: res,
      content,
      isError: Boolean((res as Record<string, unknown>)['isError']),
    };
  }

  async disconnect(): Promise<void> {
    try {
      if (this.client) await this.client.close();
    } catch { /* ignore */ }
    try {
      if (this.transport) await this.transport.close();
    } catch { /* ignore */ }
    if (this.childProc && !this.childProc.killed) {
      this.childProc.kill('SIGTERM');
    }
    this.client = undefined;
    this.transport = undefined;
    this.childProc = undefined;
  }
}

/** Convenience: launch a child without going through the MCP transport — used for raw probes. */
export function spawnSilent(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { stdio: ['ignore', 'ignore', 'ignore'] });
}

/**
 * Concatenate text content blocks, attempt JSON.parse on the result.
 * Returns the parsed value or `undefined` if no text blocks or parse fails.
 */
export function tryParseJsonContent(content: readonly { type: string; text?: string }[]): unknown {
  const text = content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!)
    .join('');
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
