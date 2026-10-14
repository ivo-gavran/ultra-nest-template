import { describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { Request, RequestHandler, Response } from 'express';
import { applyTrustProxy } from '../src/modules/security/http-hardening.js';

// Vitest's AST coverage exposes the missing-IP fallback separately from invalid
// forwarded IPs exercised over HTTP. Keep the existing branch floor intact.
describe('Client identity validation', () => {
  it('rejects a missing IP before creating a rate bucket or authenticating', () => {
    const use = vi.fn<(handler: RequestHandler) => void>();
    applyTrustProxy({ use } as unknown as INestApplication, {
      TRUST_PROXY: 'false',
    });
    const json = vi.fn<Response['json']>();
    const status = vi
      .fn<Response['status']>()
      .mockReturnValue({ json } as unknown as Response);
    const next = vi.fn();

    use.mock.calls[0][0](
      {} as Request,
      { status } as unknown as Response,
      next,
    );

    expect(status).toHaveBeenCalledExactlyOnceWith(400);
    expect(json).toHaveBeenCalledExactlyOnceWith({
      statusCode: 400,
      message: 'Bad Request',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
