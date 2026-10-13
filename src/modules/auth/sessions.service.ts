import { createHash } from 'node:crypto';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TokenService } from '@nestjs/authentication';
import { SessionsRepository } from './sessions.repository.js';
import type { SessionQuery, SessionPage } from './schemas/session.schema.js';

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly repository: SessionsRepository,
    private readonly tokens: TokenService,
  ) {}

  async list(
    userId: string,
    currentId: string | undefined,
    query: SessionQuery,
  ): Promise<SessionPage> {
    return this.safely(async () => {
      const rows = await this.repository.list(userId, query);
      const items = rows.slice(0, query.limit).map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        status: row.status,
        current: row.id === currentId,
      }));
      return {
        items,
        nextCursor: rows.length > query.limit ? items.at(-1)!.id : null,
      };
    });
  }

  async revoke(
    userId: string,
    sessionId: string,
    refreshToken: string | undefined,
  ): Promise<boolean> {
    return this.safely(async () => {
      // Bearer sid identifies the access token's login, not the browser cookie.
      const clearCookie =
        !!refreshToken &&
        refreshToken.length <= 128 &&
        (await this.repository.hasRefreshToken(
          userId,
          sessionId,
          createHash('sha256').update(refreshToken).digest('base64url'),
        ));
      if (await this.repository.revoke(userId, sessionId)) {
        // Deliberately omit actor/session identifiers, claims and request data.
        this.logger.log('auth.session.revoked');
      }
      return clearCookie;
    });
  }

  async logoutAll(userId: string): Promise<void> {
    await this.safely(() => this.tokens.revokeAll(userId));
  }

  private async safely<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch {
      throw new ServiceUnavailableException(
        'Authentication temporarily unavailable',
      );
    }
  }
}
