import { NextResponse } from 'next/server';
import { z } from 'zod';
import { withAuth } from '@/lib/auth/middleware';
import { updateUserName, toPublicUser } from '@/lib/db/queries/users';

const profileSchema = z.object({ name: z.string().trim().max(60).nullable() });

export const PUT = withAuth(async (req) => {
  try {
    const { name } = profileSchema.parse(await req.json());
    const user = await updateUserName(req.userId!, name || null);
    return NextResponse.json({ success: true, user: toPublicUser(user) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'Name must be 60 characters or fewer' }, { status: 400 });
    }
    console.error('Update profile error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
});
