import { Injectable } from '@nestjs/common';
import {
  AuthenticationRegistry,
  JwtBearerProvider,
} from '@nestjs/authentication';
import type { JwtClaims } from '@nestjs/authentication';
import { z } from 'zod';
import { UsersService } from '../users/users.service.js';
import type { PublicUser } from '../users/schemas/user.schema.js';

@Injectable()
export class BearerProvider extends JwtBearerProvider<PublicUser> {
  constructor(
    registry: AuthenticationRegistry,
    private readonly users: UsersService,
  ) {
    super();
    registry.registerProvider(this);
  }

  protected validate(claims: JwtClaims) {
    const id = z.uuid().safeParse(claims.sub);
    return id.success ? this.users.findById(id.data) : null;
  }
}
