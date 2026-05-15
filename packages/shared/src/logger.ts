/**
 * Structured logger factory using Pino.
 *
 * Every log entry includes service name and correlation ID.
 * Logs to both stderr and a log file (JSON) when file logging is enabled.
 * Never use console.log — always use this logger.
 */

import pino from 'pino';
import type { Logger } from 'pino';
import { mkdirSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';

export interface LoggerOptions {
  readonly service: string;
  readonly level?: string;
}

const pinoOptions = {
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label: string) {
      return { level: label };
    },
  },
  redact: {
    paths: ['token', 'password', 'secret', 'authorization', 'gitToken'],
    censor: '[REDACTED]',
  },
};

let multiStream: pino.MultiStreamRes | undefined;

/**
 * Initialise file logging. Call once at startup with the data directory.
 * All loggers created after this will write to both stderr and the log file.
 */
export function initFileLogging(logDir: string): void {
  const absLogDir = resolve(logDir);
  mkdirSync(absLogDir, { recursive: true });
  const logFile = join(absLogDir, 'ekg.log');

  const fileStream = createWriteStream(logFile, { flags: 'a' });

  multiStream = pino.multistream([
    { stream: process.stderr },
    { stream: fileStream },
  ]);
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';

  if (multiStream) {
    return pino({ ...pinoOptions, name: options.service, level }, multiStream);
  }

  // stderr only (before initFileLogging is called)
  return pino({ ...pinoOptions, name: options.service, level });
}

export function createChildLogger(
  parent: Logger,
  context: Readonly<Record<string, unknown>>,
): Logger {
  return parent.child(context);
}

export type { Logger };
