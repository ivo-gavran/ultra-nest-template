import type { CookieOptions } from 'express';

export const cookieName = '__Host-refresh';
export const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: '/',
};
