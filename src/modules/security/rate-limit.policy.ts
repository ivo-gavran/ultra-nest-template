import { Reflector } from '@nestjs/core';

// Opt in to one stricter IP policy. Unannotated routes retain global protection.
export const RateLimit = Reflector.createDecorator<'auth' | 'account'>();
