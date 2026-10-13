import { MetricReader } from '@opentelemetry/sdk-metrics';
import type { HistogramMetricData } from '@opentelemetry/sdk-metrics';
import { JsonLogger } from '../../src/modules/observability/json-logger.js';
import type { JsonLogOptions } from '../../src/modules/observability/json-logger.js';
import type { SentryTransport } from '../../src/modules/observability/sentry.js';

export type LogRecord = Record<string, unknown>;

// The production logger; records the exact objects it would print.
export class CapturingJsonLogger extends JsonLogger {
  readonly records: LogRecord[] = [];

  protected override printAsJson(message: unknown, options: JsonLogOptions) {
    this.records.push(
      JSON.parse(
        JSON.stringify(this.getJsonLogObject(message, options)),
      ) as LogRecord,
    );
  }
}

export interface SentryEvent {
  [key: string]: unknown;
  tags?: Record<string, string>;
  exception?: { values?: { type?: string; value?: string }[] };
}

export function sentryRecorder() {
  const envelopes: unknown[] = [];
  const transport: SentryTransport = () => ({
    send: (envelope) => {
      envelopes.push(JSON.parse(JSON.stringify(envelope)));
      return Promise.resolve({});
    },
    flush: () => Promise.resolve(true),
  });
  const items = () =>
    (envelopes as [unknown, [{ type: string }, unknown][]][]).flatMap(
      ([, entries]) => entries,
    );
  return {
    transport,
    envelopes,
    events: () =>
      items()
        .filter(([header]) => header.type === 'event')
        .map(([, payload]) => payload as SentryEvent),
    itemTypes: () => items().map(([header]) => header.type),
  };
}

// Pull-based reader: metrics are collected only when the test asks.
export class TestMetricReader extends MetricReader {
  protected onForceFlush() {
    return Promise.resolve();
  }
  protected onShutdown() {
    return Promise.resolve();
  }

  async histogram(name: string) {
    const { resourceMetrics } = await this.collect();
    return resourceMetrics.scopeMetrics
      .flatMap((scope) => scope.metrics)
      .filter(
        (metric): metric is HistogramMetricData =>
          metric.descriptor.name === name,
      )
      .flatMap((metric) => metric.dataPoints);
  }
}
