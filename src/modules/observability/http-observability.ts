import { AsyncResource } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { Logger } from '@nestjs/common';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  propagation,
  trace,
} from '@opentelemetry/api';
import type { Attributes } from '@opentelemetry/api';
import type { Request, RequestHandler } from 'express';
import {
  REQUEST_ID_HEADER,
  runWithRequestContext,
  selectRequestId,
} from './request-context.js';
import { activeTracer, recordHttpRequest } from './telemetry.js';

const METHODS = new Set([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
  'CONNECT',
  'TRACE',
]);

export function normalizeMethod(method: string): string {
  return METHODS.has(method) ? method : '_OTHER';
}

// The matched route template (e.g. /api/v1/users/:id), never the raw URL.
// Unmatched requests (404, or failures before routing) have no route. Nest
// registers controller routes with absolute templates; its not-found handler
// is a relative `*path` route inside the global-prefix router.
export function routeTemplate(request: Request): string | undefined {
  const path: unknown = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' && path.startsWith('/') ? path : undefined;
}

export interface HttpObservabilityOptions {
  // Probe paths: no span or metric, and no log unless the probe fails.
  quietPaths: readonly string[];
}

// Registered before every other middleware so the correlation header, log
// and span cover requests rejected by IP validation, body parsing, CSRF,
// CORS, throttling, guards and routing.
export function observeHttpRequests(
  options: HttpObservabilityOptions,
): RequestHandler {
  const logger = new Logger('HTTP');
  const quietPaths = new Set(options.quietPaths);

  return (request, response, next) => {
    const startedAt = performance.now();
    const requestId = selectRequestId(request.headers['x-request-id']);
    response.setHeader(REQUEST_ID_HEADER, requestId);
    const method = normalizeMethod(request.method);
    const quiet = quietPaths.has(request.path);
    const tracer = quiet ? undefined : activeTracer();
    const parent = tracer
      ? propagation.extract(ROOT_CONTEXT, request.headers)
      : ROOT_CONTEXT;
    const span = tracer?.startSpan(
      method,
      {
        kind: SpanKind.SERVER,
        attributes: { 'http.request.method': method },
      },
      parent,
    );

    const complete = () => {
      const route = routeTemplate(request);
      const aborted = !response.writableFinished;
      const statusCode = response.statusCode;
      const durationMs = performance.now() - startedAt;
      const errorType = aborted
        ? 'aborted'
        : statusCode >= 500
          ? String(statusCode)
          : undefined;
      const attributes: Attributes = {
        'http.request.method': method,
        ...(route ? { 'http.route': route } : {}),
        ...(aborted ? {} : { 'http.response.status_code': statusCode }),
        ...(errorType ? { 'error.type': errorType } : {}),
      };
      if (span) {
        span.updateName(route ? `${method} ${route}` : method);
        span.setAttributes(attributes);
        if (!aborted && statusCode >= 500)
          span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
      }
      if (!quiet) recordHttpRequest(durationMs / 1_000, attributes);
      if (quiet && !aborted && statusCode < 400) return;
      const fields = {
        method,
        ...(route ? { route } : {}),
        ...(aborted ? {} : { statusCode }),
        durationMs: Math.round(durationMs * 1_000) / 1_000,
      };
      if (aborted) logger.warn('http.request.aborted', fields);
      else if (statusCode >= 500) logger.warn('http.request.completed', fields);
      else logger.log('http.request.completed', fields);
    };

    runWithRequestContext({ requestId }, () =>
      context.with(span ? trace.setSpan(parent, span) : parent, () => {
        // 'close' fires exactly once per response: after it is fully sent,
        // or when the client disconnects first (aborted).
        response.once('close', AsyncResource.bind(complete));
        next();
      }),
    );
  };
}
