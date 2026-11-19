import { getDbPool } from '../client';

export interface User {
  id: string;
  email: string;
  name?: string | null;
  password_hash: string;
  password_reset_token?: string | null;
  password_reset_expires?: Date | null;
  created_at: Date;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createUser(email: string, passwordHash: string, name?: string | null): Promise<User> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING *',
    [normalizeEmail(email), passwordHash, name || null]
  );
  return result.rows[0];
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'SELECT * FROM users WHERE LOWER(email) = $1',
    [normalizeEmail(email)]
  );
  return result.rows[0] || null;
}

export async function getUserById(id: string): Promise<User | null> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'SELECT * FROM users WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getUserByResetToken(token: string): Promise<User | null> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'SELECT * FROM users WHERE password_reset_token = $1 AND password_reset_expires > NOW()',
    [token]
  );
  return result.rows[0] || null;
}

export async function setPasswordResetToken(email: string, token: string, expiresAt: Date): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    'UPDATE users SET password_reset_token = $1, password_reset_expires = $2 WHERE LOWER(email) = $3',
    [token, expiresAt, normalizeEmail(email)]
  );
}

export async function updateUserPassword(userId: string, passwordHash: string): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    'UPDATE users SET password_hash = $1, password_reset_token = NULL, password_reset_expires = NULL WHERE id = $2',
    [passwordHash, userId]
  );
}

export async function updateUserEmail(userId: string, email: string): Promise<User> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'UPDATE users SET email = $1 WHERE id = $2 RETURNING *',
    [normalizeEmail(email), userId]
  );
  return result.rows[0];
}

export async function updateUserName(userId: string, name: string | null): Promise<User> {
  const pool = getDbPool();
  const result = await pool.query<User>(
    'UPDATE users SET name = $1 WHERE id = $2 RETURNING *',
    [name || null, userId]
  );
  return result.rows[0];
}

export function toPublicUser(user: User) {
  return { id: user.id, email: user.email, name: user.name || null };
}
