import { Policy } from '@nestjs/authorization';
import type { PublicUser } from '../../users/schemas/user.schema.js';

@Policy()
export class UsersPolicy {
  // The future self endpoint must use the authenticated user ID, not input.
  readSelf(user: PublicUser | null): boolean {
    return user?.role === 'user' || user?.role === 'admin';
  }

  // No global admin override: only routes explicitly declaring this ability.
  manage(user: PublicUser | null): boolean {
    return user?.role === 'admin';
  }
}
