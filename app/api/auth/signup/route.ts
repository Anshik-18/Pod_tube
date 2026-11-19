import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createUser, getUserByEmail, toPublicUser } from '@/lib/db/queries/users';
import { hashPassword } from '@/lib/auth/password';
import { signToken } from '@/lib/auth/jwt';
import { setAuthCookie } from '@/lib/auth/cookie';
import { clientIp, rateLimit } from '@/lib/auth/rate-limit';

const signupSchema = z.object({
  name: z.string().trim().max(60).optional(),
  email: z.string().trim().email(),
  password: z.string().min(8),
});

export async function POST(req: NextRequest) {
  try {
    const limit = rateLimit(`signup:${clientIp(req)}`, 5, 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: 'Too many attempts. Please wait a minute.' }, { status: 429 });
    }

    const { name, email, password } = signupSchema.parse(await req.json());

    if (await getUserByEmail(email)) {
      return NextResponse.json({ error: 'An account with this email already exists' }, { status: 400 });
    }

    const user = await createUser(email, await hashPassword(password), name || null);
    const token = signToken({ userId: user.id, email: user.email });

    const response = NextResponse.json({ user: toPublicUser(user), token });
    setAuthCookie(response, token);
    return response;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const field = error.errors[0]?.path[0];
      const message = field === 'password' ? 'Password must be at least 8 characters' : 'Enter a valid email address';
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('Signup error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
