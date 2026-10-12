import { Injectable, ForbiddenException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type { Environment } from '../../config/environment.js';

@Injectable()
export class BrowserOriginGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Environment, true>) {}
  canActivate(context: ExecutionContext): boolean {
    const http = context.switchToHttp();
    http.getResponse<Response>().setHeader('Cache-Control', 'no-store');
    const origin = http.getRequest<Request>().headers.origin;
    if (
      !origin ||
      !this.config.get('AUTH_TRUSTED_ORIGINS', { infer: true }).includes(origin)
    )
      throw new ForbiddenException();
    return true;
  }
}
