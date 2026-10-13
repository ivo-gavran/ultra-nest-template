import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Environment } from '../../config/environment.js';

// Applies the validated TRUST_PROXY setting to Express. `false` (default)
// keeps Express's own default: forwarding headers are ignored and req.ip is
// the socket peer. Never set blanket `true`.
export function applyTrustProxy(
  app: INestApplication,
  config: Pick<Environment, 'TRUST_PROXY'>,
): void {
  const trustProxy = config.TRUST_PROXY;
  if (trustProxy === 'false') return;
  (app as NestExpressApplication).set('trust proxy', trustProxy);
}

// Replaces the default parsers (registered by Nest at init) with capped
// ones. body-parser rejects oversized bodies with 413 before routing.
export function applyBodyLimits(
  app: INestApplication,
  config: Pick<Environment, 'REQUEST_BODY_LIMIT_BYTES'>,
): void {
  const express = app as NestExpressApplication;
  express.useBodyParser('json', { limit: config.REQUEST_BODY_LIMIT_BYTES });
  express.useBodyParser('urlencoded', {
    limit: config.REQUEST_BODY_LIMIT_BYTES,
    extended: true,
  });
}
