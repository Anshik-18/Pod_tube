import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { getUserByEmail, setPasswordResetToken } from '@/lib/db/queries/users';
import { clientIp, rateLimit } from '@/lib/auth/rate-limit';

const forgotPasswordSchema = z.object({
  email: z.string().trim().email(),
});

const GENERIC_MESSAGE = 'If an account with that email exists, a password reset link has been sent.';

export async function POST(req: NextRequest) {
  try {
    const limit = rateLimit(`forgot:${clientIp(req)}`, 5, 15 * 60_000);
    if (!limit.ok) {
      return NextResponse.json({ error: 'Too many requests. Please try again later.' }, { status: 429 });
    }

    const { email } = forgotPasswordSchema.parse(await req.json());

    const user = await getUserByEmail(email);
    if (!user) {
      // Same response either way so account existence isn't revealed
      return NextResponse.json({ success: true, message: GENERIC_MESSAGE });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    await setPasswordResetToken(user.email, resetToken, expiresAt);

    // No email provider is configured: the link is logged server-side and, in development only, returned.
    const resetLink = `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
    if (process.env.NODE_ENV === 'development') {
      console.log('Password reset link (DEV ONLY):', resetLink);
    }

    return NextResponse.json({
      success: true,
      message: GENERIC_MESSAGE,
      ...(process.env.NODE_ENV === 'development' && { resetLink }),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Enter a valid email address' }, { status: 400 });
    }
    console.error('Forgot password error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
