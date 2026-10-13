import '../setup-env.js';
// Exercise production package storage enforcement, Swagger and schema defaults.
process.env.NODE_ENV = 'production';
delete process.env.SWAGGER_ENABLED;
for (const key of Object.keys(process.env)) {
  if (key.startsWith('RATE_LIMIT_')) delete process.env[key];
}
// A hostile/stale deployment flag must have no effect on route registration.
process.env.OBSERVABILITY_SQL_PROBE = '1';
