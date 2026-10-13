import { authEnvironment } from './helpers/auth-environment.js';
// @nestjs/throttler@6.7.1 ships CommonJS without "type": "module". If it is
// the first importer of @nestjs/common/@nestjs/core under Jest's VM loader,
// its internal require() of those pure-ESM packages trips Node's
// require(esm) cycle check. Loading them first (here, before any test
// module) avoids the cycle. Production ESM output needs no preload.
import '@nestjs/common';
import '@nestjs/core';
import '@nestjs/config';
import '@nestjs/platform-express';
Object.assign(process.env, authEnvironment);
// Keep application tests independent of the developer's .env and shell settings.
process.env.NODE_ENV = 'test';
process.env.PORT = '3000';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.SWAGGER_ENABLED = 'true';
// Generous limits keep pre-existing suites deterministic; dedicated
// security suites set tight limits explicitly through app fixtures.
process.env.RATE_LIMIT_GLOBAL_LIMIT = '100000';
process.env.RATE_LIMIT_AUTH_LIMIT = '10000';
process.env.RATE_LIMIT_ACCOUNT_LIMIT = '10000';
