import {
  Body,
  Controller,
  Cookies,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Can } from '@nestjs/authorization';
import { SessionsPolicy } from '../authorization/policies/sessions.policy.js';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import {
  ApiBearerAuth,
  ApiUnauthorizedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { PublicUser } from '../users/schemas/user.schema.js';
import { BrowserOriginGuard } from './browser-origin.guard.js';
import { cookieName, cookieOptions } from './refresh-cookie.js';
import { emptyAuthSchema } from './schemas/auth.schema.js';
import type { EmptyAuthInput } from './schemas/auth.schema.js';
import {
  currentSessionId,
  sessionPageSchema,
  sessionParamsSchema,
  sessionQuerySchema,
} from './schemas/session.schema.js';
import type { SessionParams, SessionQuery } from './schemas/session.schema.js';
import { SessionsService } from './sessions.service.js';

@Controller('auth')
@ApiTags('Authentication sessions')
// Session reads/revocations use global IP protection only.
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Valid bearer authentication required',
})
@ApiForbiddenResponse({
  description: 'Insufficient permission or untrusted Origin',
})
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @Get('sessions')
  @Can(SessionsPolicy, 'listOwn')
  @ApiOperation({
    summary: 'List own refresh-token families, newest first',
    description:
      'Keyset pagination: pass nextCursor as after. Current identifies the verified bearer sid. Revoked takes precedence over expired; active requires a live unspent token.',
  })
  @ApiOkResponse({ standardSchema: sessionPageSchema })
  list(
    @CurrentUser() user: PublicUser,
    @CurrentSession() context: unknown,
    @Query({ schema: sessionQuerySchema }) query: SessionQuery,
  ) {
    return this.sessions.list(user.id, currentSessionId(context), query);
  }

  @Delete('sessions/:id')
  @Can(SessionsPolicy, 'revokeOwn')
  @UseGuards(BrowserOriginGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke an owned session',
    description:
      'Requires a trusted Origin. Unknown, foreign and already-revoked IDs also return 204. Clears only a presented refresh cookie stored for this user and target session. Existing access JWTs can remain valid for 15 minutes.',
  })
  @ApiNoContentResponse()
  async revoke(
    @CurrentUser() user: PublicUser,
    @Cookies(cookieName) refreshToken: string | undefined,
    @Param({ schema: sessionParamsSchema }) params: SessionParams,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (await this.sessions.revoke(user.id, params.id, refreshToken))
      response.clearCookie(cookieName, cookieOptions);
  }

  @Post('logout-all')
  @Can(SessionsPolicy, 'logoutAll')
  @UseGuards(BrowserOriginGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Revoke all existing refresh families',
    description:
      'Requires a trusted Origin. New logins afterwards are allowed. Existing access JWTs can remain valid for 15 minutes.',
  })
  @ApiNoContentResponse()
  async logoutAll(
    @CurrentUser() user: PublicUser,
    @Body({ schema: emptyAuthSchema }) _input: EmptyAuthInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.logoutAll(user.id);
    response.clearCookie(cookieName, cookieOptions);
  }
}
