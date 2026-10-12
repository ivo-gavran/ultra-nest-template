import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiProduces,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AppService } from './app.service.js';
import { greetingSchema } from './greeting.schema.js';
import type { Greeting } from './greeting.schema.js';

@Controller()
@ApiProduces('text/plain')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @ApiOkResponse({ standardSchema: z.string() })
  getHello(): string {
    return this.appService.getHello();
  }

  @Post('greetings')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ standardSchema: z.string() })
  @ApiBadRequestResponse({ description: 'Invalid request payload' })
  greet(@Body({ schema: greetingSchema }) body: Greeting): string {
    return this.appService.getHello(body.name);
  }
}
