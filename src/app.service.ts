import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(name = 'World'): string {
    return `Hello ${name}!`;
  }
}
