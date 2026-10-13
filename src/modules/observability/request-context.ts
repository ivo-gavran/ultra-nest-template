import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-ID';

// Accept only opaque IDs that cannot carry log syntax, emails, JWTs (dots),
// whitespace or duplicates (Node joins repeated headers with ", ").
const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;

// Correlation only. Never an identity, authorization or tenancy signal.
export interface RequestContext {
  readonly requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function selectRequestId(header: unknown): string {
  return typeof header === 'string' && REQUEST_ID.test(header)
    ? header
    : randomUUID();
}

export function runWithRequestContext<T>(
  context: RequestContext,
  callback: () => T,
): T {
  return storage.run(context, callback);
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}
