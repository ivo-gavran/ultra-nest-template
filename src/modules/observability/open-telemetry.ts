import { Logger } from '@nestjs/common';
import { context, propagation, trace } from '@opentelemetry/api';
import type { Histogram, Tracer } from '@opentelemetry/api';
import {
  W3CTraceContextPropagator,
  loggingErrorHandler,
  setGlobalErrorHandler,
} from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import type { MetricReader } from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import type {
  SpanExporter,
  SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { TelemetryEnvironment } from '../../config/telemetry.js';

export interface OpenTelemetryOverrides {
  spanExporter?: SpanExporter;
  metricReader?: MetricReader;
  // Postgres instrumentation hooks `require`; it only takes effect when pg is
  // loaded after startup (true in production, not inside the Jest VM).
  instrumentPostgres?: boolean;
}

export interface OpenTelemetryRuntime {
  readonly tracer: Tracer;
  readonly requestDuration: Histogram;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const EXPORT_FAILURE_LOG_INTERVAL_MS = 60_000;

// Semantic-conventions HTTP duration buckets (seconds).
const DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
];

// Statement / parameter attribute keys that must never leave the process.
// `@opentelemetry/instrumentation-pg` always sets `db.query.text` from the
// query string (even with `enhancedDatabaseReporting: false`); legacy
// semconv and enhanced-mode keys are listed for defense in depth.
const STATEMENT_ATTRIBUTE_KEYS = new Set([
  'db.query.text',
  'db.statement',
  'db.statement.parameters',
  'db.postgresql.values',
  'db.connection_string',
]);

export function isStatementAttributeKey(key: string): boolean {
  return (
    STATEMENT_ATTRIBUTE_KEYS.has(key) ||
    key.startsWith('db.query.parameter') ||
    key.startsWith('db.operation.parameter') ||
    key.startsWith('db.statement.')
  );
}

// Strip statement text and free-text status messages before any exporter
// sees the span. Safe metadata (db.system.name, db.namespace, operation
// name, server address/port) and timing are preserved. This is not a
// content regex scrubber: known statement attribute keys are removed.
export function scrubSpanForExport(span: {
  status: { code: number; message?: string };
  setStatus(status: { code: number }): void;
  attributes: Record<string, unknown>;
}): void {
  if (span.status.message !== undefined)
    span.setStatus({ code: span.status.code });
  for (const key of Object.keys(span.attributes)) {
    if (isStatementAttributeKey(key)) delete span.attributes[key];
  }
}

const privacySpanProcessor: SpanProcessor = {
  onStart: () => undefined,
  onEnding: (span) => {
    scrubSpanForExport(span);
  },
  onEnd: () => undefined,
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

function exportFailureHandler() {
  const logger = new Logger('Telemetry');
  let lastLogged = -Infinity;
  return () => {
    const now = Date.now();
    if (now - lastLogged < EXPORT_FAILURE_LOG_INTERVAL_MS) return;
    lastLogged = now;
    logger.warn('telemetry.export.failed');
  };
}

// Single owner of the global tracer provider, context manager and
// propagator. Metrics use a non-global MeterProvider so instrumentation
// libraries keep a no-op meter and only the manual HTTP metric is exported.
export function startOpenTelemetry(
  environment: TelemetryEnvironment,
  overrides: OpenTelemetryOverrides = {},
): OpenTelemetryRuntime {
  const endpoint = environment.OTEL_EXPORTER_OTLP_ENDPOINT!;
  const exporterOptions = {
    headers: environment.OTEL_EXPORTER_OTLP_HEADERS ?? {},
    timeoutMillis: environment.OTEL_EXPORTER_OTLP_TIMEOUT,
  };
  // Only the service name and deployment environment: no host, process,
  // container or OTEL_RESOURCE_ATTRIBUTES detection.
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: environment.OTEL_SERVICE_NAME,
    'deployment.environment.name': environment.NODE_ENV,
  });

  setGlobalErrorHandler(exportFailureHandler());

  // Inbound traceparent is client-controlled: its sampled flag may lower but
  // never raise the configured ratio. Trace-ID ratio sampling stays
  // consistent with upstream services using the same or a higher ratio.
  const ratio = new TraceIdRatioBasedSampler(
    environment.OTEL_TRACES_SAMPLER_ARG,
  );
  const tracerProvider = new NodeTracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: ratio,
      remoteParentSampled: ratio,
    }),
    spanLimits: {
      attributeCountLimit: 64,
      attributeValueLengthLimit: 2_048,
      eventCountLimit: 32,
      linkCountLimit: 8,
    },
    spanProcessors: [
      privacySpanProcessor,
      new BatchSpanProcessor(
        overrides.spanExporter ??
          new OTLPTraceExporter({
            ...exporterOptions,
            url: `${endpoint}/v1/traces`,
          }),
        {
          maxQueueSize: 2_048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5_000,
          exportTimeoutMillis: environment.OTEL_EXPORTER_OTLP_TIMEOUT,
        },
      ),
    ],
  });
  // Trace context only; W3C baggage is neither accepted nor propagated.
  tracerProvider.register({ propagator: new W3CTraceContextPropagator() });

  const meterProvider = new MeterProvider({
    resource,
    readers: [
      overrides.metricReader ??
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            ...exporterOptions,
            url: `${endpoint}/v1/metrics`,
          }),
          exportIntervalMillis: environment.OTEL_METRIC_EXPORT_INTERVAL,
          exportTimeoutMillis: environment.OTEL_EXPORTER_OTLP_TIMEOUT,
        }),
    ],
  });

  const disableInstrumentations =
    overrides.instrumentPostgres === false
      ? () => undefined
      : registerInstrumentations({
          tracerProvider,
          instrumentations: [
            new PgInstrumentation({
              requireParentSpan: true,
              ignoreConnectSpans: true,
              enhancedDatabaseReporting: false,
              addSqlCommenterCommentToQueries: false,
              enableTraceContextPropagation: false,
            }),
          ],
        });

  const tracer = tracerProvider.getTracer('ultra-nest-template.http');
  const requestDuration = meterProvider
    .getMeter('ultra-nest-template.http')
    .createHistogram('http.server.request.duration', {
      unit: 's',
      description: 'Duration of HTTP server requests.',
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    });

  return {
    tracer,
    requestDuration,
    async flush() {
      await Promise.allSettled([
        tracerProvider.forceFlush(),
        meterProvider.forceFlush(),
      ]);
    },
    async shutdown() {
      disableInstrumentations();
      await Promise.allSettled([
        tracerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
      trace.disable();
      context.disable();
      propagation.disable();
      setGlobalErrorHandler(loggingErrorHandler());
    },
  };
}
