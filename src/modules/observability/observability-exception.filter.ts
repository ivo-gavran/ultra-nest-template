import {
  Catch,
  HttpException,
  HttpStatus,
  IntrinsicException,
  Logger,
} from '@nestjs/common';
import type { ArgumentsHost, HttpServer } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { AbstractHttpAdapter } from '@nestjs/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Request } from 'express';
import { normalizeMethod, routeTemplate } from './http-observability.js';
import { errorType, sanitizeErrorMessage } from './redaction.js';
import { captureUnexpectedError } from './sentry.js';

// Reporting policy:
// - 4xx HttpException / client http-errors: expected; Nest response only.
// - 503 HttpException: deliberate dependency/capacity outcomes (readiness,
//   sanitized persistence failures); Nest response only — no Sentry noise.
// - Other 5xx HttpException (including InternalServerErrorException): Nest
//   response preserved; exactly one log, span exception and Sentry event.
// - Non-HttpException: Nest body (http-errors keep status; others → generic
//   500); report unless IntrinsicException or client http-error.
// Responses are never rewritten to expose stacks. Nothing is rethrown or
// swallowed; non-HTTP exceptions are reported only from handleUnknownError.
@Catch()
export class ObservabilityExceptionFilter extends BaseExceptionFilter {
  private readonly logger = new Logger('ExceptionsHandler');

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (exception instanceof HttpException) {
      super.catch(exception, host);
      if (shouldReportHttpException(exception))
        this.report(exception, host.switchToHttp().getRequest<Request>());
      return;
    }
    super.catch(exception, host);
  }

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

export function shouldReportHttpException(exception: HttpException): boolean {
  const status = exception.getStatus();
  // Deliberate operational unavailability (readiness / sanitized storage
  // failures) uses HTTP 503 and must not create Sentry noise.
  return status >= 500 && status !== 503;
}
