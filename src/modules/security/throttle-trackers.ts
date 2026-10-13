import { createHash } from 'node:crypto';

// Throttler trackers/generators derive keys from these values only. Keys are
// hashed by the guard and never logged, but avoid embedding raw emails or
// credentials anyway: auth-specific trackers use the socket identity.
// Each handler keeps its own controller+handler-prefixed key namespace.
export const clientIpTracker = (request: Record<string, unknown>): string => {
  const ip = typeof request.ip === 'string' ? request.ip : '';
  return ip || 'unknown';
};

export const authenticatedActorTracker = (
  request: Record<string, unknown>,
): string => {
  const user = (request as { user?: { id?: unknown } }).user;
  if (typeof user?.id === 'string' && user.id) return `user:${user.id}`;
  return clientIpTracker(request);
};

export const hashEmailBodyTracker = (
  request: Record<string, unknown>,
): string => {
  const body: unknown = (request as { body?: unknown }).body;
  let email = '';
  if (body !== null && typeof body === 'object' && 'email' in body) {
    const value = (body as { email?: unknown }).email;
    if (typeof value === 'string') email = value.trim().toLowerCase();
  }
  if (!email) return clientIpTracker(request);
  const digest = createHash('sha256').update(email).digest('hex');
  return `${clientIpTracker(request)}:${digest}`;
};
