'use client';

const TOKEN_KEY = 'token';

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (private mode); the httpOnly cookie still authenticates requests.
  }
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public data?: unknown) {
    super(message);
  }
}

/**
 * fetch() for the app's JSON API: adds the bearer token, parses JSON and throws ApiError with
 * the server's message on failure.
 */
export async function api<T = any>(path: string, init: RequestInit & { json?: unknown; token?: string | null } = {}): Promise<T> {
  const { json, token = getAuthToken(), headers, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = typeof data?.error === 'string' ? data.error : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, data);
  }
  return data as T;
}

/** Start a browser download of an authenticated asset (the httpOnly cookie authorizes it). */
export function downloadFromUrl(url: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}
