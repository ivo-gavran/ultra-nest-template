import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { CurrentSession, CurrentUser } from '@nestjs/authentication';
import { Can } from '@nestjs/authorization';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { UsersPolicy } from '../authorization/policies/users.policy.js';
import { authenticatedActorTracker } from '../security/throttle-trackers.js';
import { BrowserOriginGuard } from '../auth/browser-origin.guard.js';
import { cookieName, cookieOptions } from '../auth/refresh-cookie.js';
import { emptyAuthSchema } from '../auth/schemas/auth.schema.js';
import type { EmptyAuthInput } from '../auth/schemas/auth.schema.js';
import { currentSessionId } from '../auth/schemas/session.schema.js';
import {
  adminUpdateUserSchema,
  changePasswordSchema,
  publicUserResponseSchema,
  updateUserSchema,
  userPageSchema,
  userParamsSchema,
  userQuerySchema,
} from './schemas/user.schema.js';
import type {
  AdminUpdateUserInput,
  ChangePasswordInput,
  PublicUser,
  UpdateUserInput,
  UserParams,
  UserQuery,
} from './schemas/user.schema.js';
import { UsersService } from './users.service.js';

@Controller('users')
@ApiTags('Users')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'Valid bearer authentication required',
})
@ApiForbiddenResponse({
  description: 'Insufficient permission or untrusted Origin',
})
@ApiBadRequestResponse({ description: 'Invalid input or current password' })
@ApiNotFoundResponse({ description: 'User not found' })
@ApiConflictResponse({
  description:
    'Email conflict, changed credentials or administrative self-target',
})
@ApiServiceUnavailableResponse({
  description: 'Account operation temporarily unavailable',
})
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // Read-only routes use only the global limiter.
  @Get('me')
  @Can(UsersPolicy, 'readSelf')
  @ApiOperation({ summary: 'Read your public profile' })
  @ApiOkResponse({ standardSchema: publicUserResponseSchema })
  me(@CurrentUser() user: PublicUser) {
    return this.users.getProfile(user.id);
  }

  @Patch('me')
  @Can(UsersPolicy, 'updateSelf')
  @SkipThrottle({ account: true })
  @UseGuards(BrowserOriginGuard)
  @ApiOperation({
    summary: 'Update your email or display name',
    description:
      'Requires a trusted Origin. Unknown and privileged fields are rejected.',
  })
  @ApiOkResponse({ standardSchema: publicUserResponseSchema })
  updateMe(
    @CurrentUser() user: PublicUser,
    @Body({ schema: updateUserSchema }) input: UpdateUserInput,
  ) {
    return this.users.updateProfile(user.id, input);
  }

  @Patch('me/password')
  @Can(UsersPolicy, 'changeOwnPassword')
  @Throttle({ account: { getTracker: authenticatedActorTracker } })
  @UseGuards(BrowserOriginGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Change your password and revoke other refresh families',
    description:
      'Requires current password and trusted Origin. Preserves only an owned, usable family matching the verified bearer sid; otherwise revokes all. Never alters the browser cookie. Existing access JWTs can remain valid for 15 minutes.',
  })
  @ApiNoContentResponse()
  changePassword(
    @CurrentUser() user: PublicUser,
    @CurrentSession() context: unknown,
    @Body({ schema: changePasswordSchema }) input: ChangePasswordInput,
  ) {
    return this.users.changePassword(user.id, currentSessionId(context), input);
  }

  @Delete('me')
  @Can(UsersPolicy, 'deleteSelf')
  @SkipThrottle({ account: true })
  @UseGuards(BrowserOriginGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Permanently delete your account',
    description:
      'Requires a trusted Origin. Transactionally retains revocation tombstones and cascades families/tokens; clears the browser refresh cookie only after commit. Subsequent bearer requests fail.',
  })
  @ApiNoContentResponse()
  async deleteMe(
    @CurrentUser() user: PublicUser,
    @Body({ schema: emptyAuthSchema }) _input: EmptyAuthInput,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.users.deleteSelf(user.id);
    response.clearCookie(cookieName, cookieOptions);
  }

  @Get()
  @Can(UsersPolicy, 'manage')
  @ApiOperation({
    summary: 'List users (administrator)',
    description:
      'Literal case-insensitive email/name search. Keyset pagination ordered by createdAt or email then UUID, both in the chosen direction. Pass nextCursor as after with the same search/sort/order. Live view; missing cursor gives an empty page.',
  })
  @ApiOkResponse({ standardSchema: userPageSchema })
  list(@Query({ schema: userQuerySchema }) query: UserQuery) {
    return this.users.list(query);
  }

  @Get(':id')
  @Can(UsersPolicy, 'manage')
  @ApiOperation({ summary: 'Read a user (administrator)' })
  @ApiOkResponse({ standardSchema: publicUserResponseSchema })
  get(@Param({ schema: userParamsSchema }) params: UserParams) {
    return this.users.getProfile(params.id);
  }

  @Patch(':id')
  @Can(UsersPolicy, 'manage')
  @Throttle({ account: { getTracker: authenticatedActorTracker } })
  @UseGuards(BrowserOriginGuard)
  @ApiOperation({
    summary: 'Update a user (administrator)',
    description:
      'Requires a trusted Origin. Explicit email/displayName/role allowlist. Database roles take effect on the next request; self-demotion returns 409.',
  })
  @ApiOkResponse({ standardSchema: publicUserResponseSchema })
  update(
    @CurrentUser() user: PublicUser,
    @Param({ schema: userParamsSchema }) params: UserParams,
    @Body({ schema: adminUpdateUserSchema }) input: AdminUpdateUserInput,
  ) {
    return this.users.updateAsAdmin(user, params.id, input);
  }

  @Delete(':id')
  @Can(UsersPolicy, 'manage')
  @Throttle({ account: { getTracker: authenticatedActorTracker } })
  @UseGuards(BrowserOriginGuard)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Permanently delete a user (administrator)',
    description:
      'Requires a trusted Origin. Same transaction/cascade/tombstones as self-deletion. Self-targets return 409. Does not change the administrator browser cookie.',
  })
  @ApiNoContentResponse()
  delete(
    @CurrentUser() user: PublicUser,
    @Param({ schema: userParamsSchema }) params: UserParams,
    @Body({ schema: emptyAuthSchema }) _input: EmptyAuthInput,
  ) {
    void _input;
    return this.users.deleteAsAdmin(user, params.id);
  }
}
