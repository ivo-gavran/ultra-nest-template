import 'reflect-metadata';
import { describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { SessionsPolicy } from '../src/modules/authorization/policies/sessions.policy.js';
import { UsersPolicy } from '../src/modules/authorization/policies/users.policy.js';
import type { PublicUser } from '../src/modules/users/schemas/user.schema.js';

const principal = (role: PublicUser['role']): PublicUser => ({
  id: randomUUID(),
  email: 'policy@example.test',
  displayName: null,
  role,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});
const sessions = new SessionsPolicy();
const users = new UsersPolicy();

describe('Explicit role permissions', () => {
  it.each([
    ['guest', null, false, false],
    ['user', principal('user'), true, false],
    ['admin', principal('admin'), true, true],
    // Fail closed if a future/invalid role reaches a policy at runtime.
    [
      'unknown',
      { ...principal('user'), role: 'operator' } as unknown as PublicUser,
      false,
      false,
    ],
  ] as const)('%s permissions', (_label, user, own, admin) => {
    expect(sessions.listOwn(user)).toBe(own);
    expect(sessions.revokeOwn(user)).toBe(own);
    expect(sessions.logoutAll(user)).toBe(own);
    expect(users.readSelf(user)).toBe(own);
    expect(users.manage(user)).toBe(admin);
  });
});
