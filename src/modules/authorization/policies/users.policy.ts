import { Policy } from '@nestjs/authorization';
import type { PublicUser } from '../../users/schemas/user.schema.js';

@Policy()
export class UsersPolicy {
  // Self endpoints use the authenticated user ID, never request identity.
  readSelf(user: PublicUser | null): boolean {
    return user?.role === 'user' || user?.role === 'admin';
  }

  updateSelf(user: PublicUser | null): boolean {
    return this.readSelf(user);
  }

  changeOwnPassword(user: PublicUser | null): boolean {
    return this.readSelf(user);
  }

  deleteSelf(user: PublicUser | null): boolean {
    return this.readSelf(user);
  }

  // No global admin override: only routes explicitly declaring this ability.
  manage(user: PublicUser | null): boolean {
    return user?.role === 'admin';
  }
}
