import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { ErrorEvent, NodeOptions } from '@sentry/nestjs';
import type { TelemetryEnvironment } from '../../config/telemetry.js';
import { sanitizeErrorMessage } from './redaction.js';
import { currentRequestId } from './request-context.js';

type SentrySdk = typeof import('@sentry/nestjs');
export type SentryTransport = NodeOptions['transport'];

let sdk: SentrySdk | undefined;

const SAFE_TAGS = new Set([
  'service',
  'request_id',
  'http.route',
  'http.request.method',
  'trace_id',
  'span_id',
]);

// Defense in depth: no integration that collects request data, breadcrumbs,
// users or local variables is installed, but strip them regardless.
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  delete event.request;
  delete event.user;
  delete event.extra;
  delete event.breadcrumbs;
  delete event.server_name;
  delete event.modules;
  if (event.message !== undefined)
    event.message = sanitizeErrorMessage(event.message) ?? '';
  event.tags = Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(([key]) => SAFE_TAGS.has(key)),
  );
  event.contexts = event.contexts?.trace
    ? { trace: event.contexts.trace }
    : undefined;
  for (const exception of event.exception?.values ?? []) {
    exception.value = sanitizeErrorMessage(exception.value) ?? '';
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.vars;
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
    }
  }
  return event;
}

// Errors only. OpenTelemetry owns tracing, so Sentry registers no tracer
// provider, propagator, module hooks or auto-instrumentation.
export async function initSentry(
  environment: TelemetryEnvironment,
  transport?: SentryTransport,
): Promise<void> {
  if (!environment.SENTRY_DSN) return;
  const sentry = await import('@sentry/nestjs');
  sentry.init({
    dsn: environment.SENTRY_DSN,
    environment: environment.NODE_ENV,
    defaultIntegrations: false,
    integrations: [
      sentry.linkedErrorsIntegration(),
      sentry.dedupeIntegration(),
    ],
    enableOpenTelemetrySetup: false,
    enableRuntimeChannelInjection: false,
    tracesSampleRate: 0,
    sampleRate: 1,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    includeServerName: false,
    includeLocalVariables: false,
    maxBreadcrumbs: 0,
    sendClientReports: false,
    debug: false,
    initialScope: { tags: { service: environment.OTEL_SERVICE_NAME } },
    beforeSend: scrubEvent,
    ...(transport ? { transport } : {}),
  });
  sdk = sentry;
}

export function captureUnexpectedError(
  error: Error,
  request: { method: string; route: string | undefined },
): void {
  const sentry = sdk;
  if (!sentry) return;
  const span = trace.getActiveSpan()?.spanContext();
  sentry.withScope((scope) => {
    const requestId = currentRequestId();
    if (requestId) scope.setTag('request_id', requestId);
    if (request.method) scope.setTag('http.request.method', request.method);
    if (request.route) scope.setTag('http.route', request.route);
    if (span && isSpanContextValid(span)) {
      scope.setTag('trace_id', span.traceId);
      scope.setTag('span_id', span.spanId);
    }
    sentry.captureException(error, {
      mechanism: { handled: false, type: 'auto.http.nestjs.exception_filter' },
    });
  });
}

export async function flushSentry(timeoutMs: number): Promise<void> {
  await sdk?.flush(timeoutMs);
}

// Flushes queued events within the deadline and disables the client, so no
// event is sent afterwards. Repeated calls are no-ops.
export async function closeSentry(timeoutMs: number): Promise<void> {
  const sentry = sdk;
  sdk = undefined;
  await sentry?.close(timeoutMs);
}
