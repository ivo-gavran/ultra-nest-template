import {
  Body,
  Controller,
  Cookies,
  HttpCode,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Public } from '@nestjs/authentication';
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { createUserSchema } from '../users/schemas/user.schema.js';
import type { CreateUserInput } from '../users/schemas/user.schema.js';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { AuthService } from './auth.service.js';
import {
  hashEmailBodyTracker,
  clientIpTracker,
} from '../security/throttle-trackers.js';
import { BrowserOriginGuard } from './browser-origin.guard.js';
import {
  loginSchema,
  emptyAuthSchema,
  accessTokenSchema,
} from './schemas/auth.schema.js';
import type { LoginInput, EmptyAuthInput } from './schemas/auth.schema.js';

import { cookieName, cookieOptions } from './refresh-cookie.js';

@Controller('auth')
@ApiTags('Authentication')
@UseGuards(BrowserOriginGuard)
// Auth routes are exempt from the generic `account` limiter; the stricter
// `auth` limiter applies per client IP plus, on register/login, per hashed
// submitted email (falling back to the client IP without a string email).
@SkipThrottle({ account: true })
@Throttle({ auth: { getTracker: clientIpTracker } })
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @Throttle({ auth: { getTracker: hashEmailBodyTracker } })
  @ApiCreatedResponse({ standardSchema: accessTokenSchema })
  async register(
    @Body({ schema: createUserSchema }) input: CreateUserInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(await this.auth.register(input), response);
  }

  @Public()
  @Post('login')
  @Throttle({ auth: { getTracker: hashEmailBodyTracker } })
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: accessTokenSchema })
  async login(
    @Body({ schema: loginSchema }) input: LoginInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.respond(await this.auth.login(input), response);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOkResponse({ standardSchema: accessTokenSchema })
  async refresh(
    @Cookies(cookieName) token: string | undefined,
    @Body({ schema: emptyAuthSchema }) _input: EmptyAuthInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    try {
      return this.respond(await this.auth.refresh(token), response);
    } catch (error) {
      if (error instanceof UnauthorizedException)
        response.clearCookie(cookieName, cookieOptions);
      throw error;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  @ApiNoContentResponse()
  async logout(
    @Cookies(cookieName) token: string | undefined,
    @Body({ schema: emptyAuthSchema }) _input: EmptyAuthInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.auth.logout(token);
    response.clearCookie(cookieName, cookieOptions);
  }

  private respond(
    pair: Awaited<ReturnType<AuthService['login']>>,
    response: Response,
  ) {
    response.cookie(cookieName, pair.refreshToken, {
      ...cookieOptions,
      expires: pair.refreshExpiresAt,
    });
    return { accessToken: pair.accessToken, expiresIn: pair.expiresIn };
  }
}
