import { environmentSchema } from './config/environment.js';
import { loadEnvironment } from './config/load-environment.js';
import { telemetryEnvironmentSchema } from './config/telemetry.js';
import type { TelemetryEnvironment } from './config/telemetry.js';
import { startTelemetry } from './modules/observability/telemetry.js';

// Instrumentation patches modules as they load, so NestJS, Express and pg are
// imported only after telemetry has started. Keep this file free of static
// application imports. The application schema is checked here too so invalid
// configuration fails before any SDK starts, with value-free diagnostics.
let telemetry: TelemetryEnvironment;
try {
  loadEnvironment(environmentSchema);
  telemetry = loadEnvironment(telemetryEnvironmentSchema);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}
await startTelemetry(telemetry);
const { bootstrap } = await import('./bootstrap.js');
await bootstrap(telemetry);
