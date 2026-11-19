'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { api, getAuthToken, setAuthToken } from '@/lib/client/api';

export interface User {
  id: string;
  email: string;
  name?: string | null;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (token: string, user?: User) => void;
  logout: () => void;
  setUser: (user: User) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUserState] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const checkAuth = useCallback(async () => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }
    try {
      const data = await api<{ user: User }>('/api/auth/me');
      setUserState(data.user);
    } catch {
      setAuthToken(null);
      setUserState(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const login = useCallback(
    (token: string, nextUser?: User) => {
      setAuthToken(token);
      if (nextUser) {
        setUserState(nextUser);
        setLoading(false);
      } else {
        checkAuth();
      }
    },
    [checkAuth]
  );

  const logout = useCallback(() => {
    setAuthToken(null);
    setUserState(null);
    fetch('/api/auth/logout', { method: 'POST' }).finally(() => router.push('/login'));
  }, [router]);

  const value = useMemo(
    () => ({ user, loading, login, logout, setUser: setUserState }),
    [user, loading, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    return { user: null, loading: false, login: () => {}, logout: () => {}, setUser: () => {} };
  }
  return context;
}
