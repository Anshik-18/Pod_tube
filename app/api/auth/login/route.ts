import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getUserByEmail, toPublicUser } from '@/lib/db/queries/users';
import { verifyPassword } from '@/lib/auth/password';
import { signToken } from '@/lib/auth/jwt';
import { setAuthCookie } from '@/lib/auth/cookie';
import { clientIp, rateLimit } from '@/lib/auth/rate-limit';

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  try {
    const limit = rateLimit(`login:${clientIp(req)}`, 10, 60_000);
    if (!limit.ok) {
      return NextResponse.json(
        { error: `Too many sign-in attempts. Try again in ${limit.retryAfterSec}s.` },
        { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec) } }
      );
    }

    const { email, password } = loginSchema.parse(await req.json());

    const user = await getUserByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
    }

    const token = signToken({ userId: user.id, email: user.email });
    const response = NextResponse.json({ user: toPublicUser(user), token });
    setAuthCookie(response, token);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Enter a valid email and password' }, { status: 400 });
    }
    console.error('Login error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
