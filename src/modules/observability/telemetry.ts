import type { Attributes } from '@opentelemetry/api';
import type { TelemetryEnvironment } from '../../config/telemetry.js';
import type {
  OpenTelemetryOverrides,
  OpenTelemetryRuntime,
} from './open-telemetry.js';
import { closeSentry, flushSentry, initSentry } from './sentry.js';
import type { SentryTransport } from './sentry.js';

export interface TelemetryOverrides extends OpenTelemetryOverrides {
  sentryTransport?: SentryTransport;
}

interface ActiveTelemetry {
  readonly openTelemetry?: OpenTelemetryRuntime;
  readonly timeoutMs: number;
}

const SHUTDOWN_GRACE_MS = 1_000;

let active: ActiveTelemetry | undefined;
let stopping: Promise<void> | undefined;

// Must complete before NestJS, Express or pg are imported. SDKs are loaded
// only when enabled, so disabled telemetry opens no connections.
export async function startTelemetry(
  environment: TelemetryEnvironment,
  overrides: TelemetryOverrides = {},
): Promise<void> {
  if (active) throw new Error('Telemetry is already started');
  await initSentry(environment, overrides.sentryTransport);
  const openTelemetry = environment.OTEL_ENABLED
    ? (await import('./open-telemetry.js')).startOpenTelemetry(
        environment,
        overrides,
      )
    : undefined;
  active = { openTelemetry, timeoutMs: environment.OTEL_EXPORTER_OTLP_TIMEOUT };
}

export function activeTracer() {
  return active?.openTelemetry?.tracer;
}

export function recordHttpRequest(
  durationSeconds: number,
  attributes: Attributes,
): void {
  active?.openTelemetry?.requestDuration.record(durationSeconds, attributes);
}

export async function flushTelemetry(): Promise<void> {
  if (!active) return;
  await Promise.allSettled([
    active.openTelemetry?.flush(),
    flushSentry(active.timeoutMs),
  ]);
}

// Flushes once and stops all exporters. Bounded even when backends hang;
// later calls (or concurrent ones) share the same result.
export function shutdownTelemetry(): Promise<void> {
  if (stopping) return stopping;
  const current = active;
  active = undefined;
  if (!current) return Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  stopping = Promise.race([
    Promise.allSettled([
      current.openTelemetry?.shutdown(),
      closeSentry(current.timeoutMs),
    ]).then(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, current.timeoutMs + SHUTDOWN_GRACE_MS);
      timer.unref();
    }),
  ]).finally(() => {
    clearTimeout(timer);
    stopping = undefined;
  });
  return stopping;
}
