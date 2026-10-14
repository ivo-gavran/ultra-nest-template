import { describe, expect, it } from 'vitest';
import {
  createUserSchema,
  updateUserSchema,
  passwordSchema,
  publicUserSchema,
} from '../src/modules/users/schemas/user.schema.js';

const valid = {
  email: '  Person@Example.com  ',
  password: 'test password phrase',
};

describe('Users input and public schemas', () => {
  it('normalizes email and display name without trimming passwords', () => {
    const input = {
      ...valid,
      password: '  test password phrase  ',
      displayName: '  Example  ',
    };
    expect(createUserSchema.parse(input)).toEqual({
      ...input,
      email: 'person@example.com',
      displayName: 'Example',
    });
  });
  it.each([
    ['invalid email', { ...valid, email: 'not-an-email' }],
    ['overlong email', { ...valid, email: `${'a'.repeat(255)}@example.com` }],
    ['short password', { ...valid, password: 'short' }],
    ['overlong password', { ...valid, password: 'a'.repeat(129) }],
    ['role assignment', { ...valid, role: 'admin' }],
    ['supplied hash', { ...valid, passwordHash: 'forbidden' }],
    ['blank name', { ...valid, displayName: '  ' }],
    ['overlong name', { ...valid, displayName: 'a'.repeat(101) }],
  ])('rejects create input: %s', (_label, input) => {
    expect(createUserSchema.safeParse(input).success).toBe(false);
  });
  it.each([
    ['empty', {}],
    ['undefined only', { email: undefined }],
    ['role', { displayName: 'Example', role: 'admin' }],
    ['id', { displayName: 'Example', id: 'forbidden' }],
    ['password', { displayName: 'Example', password: valid.password }],
    ['passwordHash', { displayName: 'Example', passwordHash: 'forbidden' }],
    ['timestamp', { displayName: 'Example', createdAt: new Date() }],
  ])('rejects update input: %s', (_label, input) => {
    expect(updateUserSchema.safeParse(input).success).toBe(false);
  });
  it('supports email-only updates and clearing an optional display name', () => {
    expect(updateUserSchema.parse({ email: valid.email })).toEqual({
      email: 'person@example.com',
    });
    expect(updateUserSchema.parse({ displayName: null })).toEqual({
      displayName: null,
    });
  });
  it('rejects passwords whose normalized encoding exceeds the hasher limit', () => {
    expect(passwordSchema.safeParse('\uFDFA'.repeat(128)).success).toBe(false);
  });
  it('rejects credential-bearing objects as public models', () => {
    const user = {
      id: 'b14c6bd1-c6d7-4771-97df-795281b13537',
      email: 'person@example.com',
      displayName: null,
      role: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(publicUserSchema.safeParse(user).success).toBe(true);
    expect(
      publicUserSchema.safeParse({ ...user, passwordHash: 'forbidden' })
        .success,
    ).toBe(false);
  });
});
