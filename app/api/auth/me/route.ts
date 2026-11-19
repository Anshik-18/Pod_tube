import { NextResponse } from 'next/server';
import { withAuth, getRequestToken } from '@/lib/auth/middleware';
import { getUserById, toPublicUser } from '@/lib/db/queries/users';
import { setAuthCookie } from '@/lib/auth/cookie';

export const GET = withAuth(async (req) => {
  try {
    const user = await getUserById(req.userId!);

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    const response = NextResponse.json({ user: toPublicUser(user) });
    // Keep the httpOnly media cookie in sync with the bearer token (e.g. sessions from before it existed).
    const token = getRequestToken(req);
    if (token && req.cookies.get('token')?.value !== token) {
      setAuthCookie(response, token);
    }
    return response;
  } catch (error) {
    console.error('Get user error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
