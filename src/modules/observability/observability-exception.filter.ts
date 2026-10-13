import { Catch, HttpStatus, IntrinsicException, Logger } from '@nestjs/common';
import type { ArgumentsHost, HttpServer } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Request } from 'express';
import { normalizeMethod, routeTemplate } from './http-observability.js';
import { errorType, sanitizeErrorMessage } from './redaction.js';
import { captureUnexpectedError } from './sentry.js';

// HttpExceptions (400/401/403/404/409/413/429/503...) are expected outcomes
// and keep Nest's handling unchanged. Anything else gets Nest's response
// body (http-errors from body parsing keep their status; others become a
// generic 500) and, unless it is a client error, exactly one error log,
// span exception and Sentry event. Nothing is rethrown or swallowed.
@Catch()
export class ObservabilityExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  override handleUnknownError(
    exception: unknown,
    host: ArgumentsHost,
    applicationRef: AbstractHttpAdapter | HttpServer,
  ): void {
    const clientError =
      this.isHttpError(exception) && exception.statusCode < 500;
    const body = this.isHttpError(exception)
      ? { statusCode: exception.statusCode, message: exception.message }
      : {
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: 'Internal server error',
        };
    const response: unknown = host.getArgByIndex(1);
    if (!applicationRef.isHeadersSent(response))
      applicationRef.reply(response, body, body.statusCode);
    else applicationRef.end(response);

    if (clientError || exception instanceof IntrinsicException) return;
    this.report(exception, host.switchToHttp().getRequest<Request>());
  }

  private report(exception: unknown, request: Request): void {
    const error =
      exception instanceof Error
        ? exception
        : new Error('Non-error value thrown');
    this.logger.error('http.request.failed', error);
    const span = trace.getActiveSpan();
    span?.recordException({
      name: errorType(error),
      message: sanitizeErrorMessage(error.message) ?? '',
    });
    span?.setStatus({ code: SpanStatusCode.ERROR });
    captureUnexpectedError(error, {
      method: normalizeMethod(request.method),
      route: routeTemplate(request),
    });
  }
}
