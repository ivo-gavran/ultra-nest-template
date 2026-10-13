// Match production's instrumentation-before-application import order while
// keeping the SQL-literal probe entirely outside the production import graph.
import { environmentSchema } from '../../src/config/environment.js';
import { loadEnvironment } from '../../src/config/load-environment.js';
import { telemetryEnvironmentSchema } from '../../src/config/telemetry.js';
import { startTelemetry } from '../../src/modules/observability/telemetry.js';

loadEnvironment(environmentSchema);
const telemetry = loadEnvironment(telemetryEnvironmentSchema);
await startTelemetry(telemetry);
const { bootstrapFixture } = await import('./observability-bootstrap.js');
await bootstrapFixture(telemetry);
