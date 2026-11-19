import type { NextResponse } from 'next/server';

const SEVEN_DAYS = 60 * 60 * 24 * 7;

const baseOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
});

/** httpOnly session cookie so media URLs (<video src>, <img src>, downloads) are authenticated. */
export function setAuthCookie(response: NextResponse, token: string): void {
  response.cookies.set('token', token, { ...baseOptions(), maxAge: SEVEN_DAYS });
}

export function clearAuthCookie(response: NextResponse): void {
  response.cookies.set('token', '', { ...baseOptions(), maxAge: 0 });
}
