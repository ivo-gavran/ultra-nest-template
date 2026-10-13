import { ConsoleLogger } from '@nestjs/common';
import type { LogLevel } from '@nestjs/common';
import { isSpanContextValid, trace } from '@opentelemetry/api';
import {
  sanitizeErrorMessage,
  serializeError,
  stackFrames,
} from './redaction.js';
import { currentRequestId } from './request-context.js';

export interface JsonLogOptions {
  context: string;
  logLevel: LogLevel;
  writeStreamType?: 'stdout' | 'stderr';
  errorStack?: unknown;
  params?: Record<string, unknown>;
  error?: Error;
}

interface JsonLogRecord {
  [key: string]: unknown;
  level: LogLevel;
  pid: number;
  timestamp: number;
  message: unknown;
}

const MAX_MESSAGE_LENGTH = 1_000;

// The only structured params ever written. Anything else passed to the logger
// (request objects, bodies, headers, users, tokens) is dropped, not redacted.
const SAFE_PARAMS: Readonly<Record<string, (value: unknown) => boolean>> = {
  method: (value) => typeof value === 'string' && /^[A-Z_]{1,16}$/.test(value),
  route: (value) => typeof value === 'string' && value.length <= 256,
  statusCode: (value) =>
    Number.isInteger(value) &&
    (value as number) >= 100 &&
    (value as number) < 600,
  durationMs: (value) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0,
};

function safeParams(params: Record<string, unknown> | undefined) {
  if (!params) return {};
  return Object.fromEntries(
    Object.entries(SAFE_PARAMS)
      .filter(([key, valid]) => valid(params[key]))
      .map(([key]) => [key, params[key]]),
  );
}

function safeMessage(message: unknown, failure: boolean): string {
  if (failure) return sanitizeErrorMessage(message) ?? 'error';
  if (typeof message !== 'string') return '[non-string message omitted]';
  return message.length > MAX_MESSAGE_LENGTH
    ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…`
    : message;
}

// Nest's native JSON format (level, pid, timestamp, message, context) plus
// service, request/trace correlation and allowlisted fields. Applies to
// framework and application logs alike. String messages from non-error logs
// are written as given: never interpolate request data or PII into them.
export class JsonLogger extends ConsoleLogger {
  constructor(private readonly service: string) {
    super({ json: true, colors: false });
  }

  protected override getJsonLogObject(
    message: unknown,
    options: JsonLogOptions,
  ): JsonLogRecord {
    const failure =
      options.error !== undefined || options.errorStack !== undefined;
    const span = trace.getActiveSpan()?.spanContext();
    const traced = span && isSpanContextValid(span);
    const error = options.error
      ? serializeError(options.error)
      : options.errorStack !== undefined
        ? { stack: stackFrames(options.errorStack) }
        : undefined;
    return {
      timestamp: Date.now(),
      level: options.logLevel,
      service: this.service,
      pid: process.pid,
      ...(options.context ? { context: options.context } : {}),
      message: safeMessage(message, failure),
      requestId: currentRequestId(),
      ...(traced ? { traceId: span.traceId, spanId: span.spanId } : {}),
      ...safeParams(options.params),
      ...(error ? { error } : {}),
    };
  }
}
