import { Policy } from '@nestjs/authorization';
import type { PublicUser } from '../../users/schemas/user.schema.js';

@Policy()
export class SessionsPolicy {
  // These allow operations on OWN sessions only. SQL enforces ownership for
  // both roles; being an administrator does not bypass the owner predicate.
  listOwn(user: PublicUser | null): boolean {
    return user?.role === 'user' || user?.role === 'admin';
  }

  revokeOwn(user: PublicUser | null): boolean {
    return user?.role === 'user' || user?.role === 'admin';
  }

  logoutAll(user: PublicUser | null): boolean {
    return user?.role === 'user' || user?.role === 'admin';
  }
}
