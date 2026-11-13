import type { User } from '@quickhub/shared';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

interface SessionState {
  token: string | null;
  user: User | null;
  setSession: (token: string, user: User) => void;
  clear: () => void;
}

/**
 * Who is signed in. Kept in sessionStorage so a page reload keeps you signed in,
 * but closing the tab signs you out (sensible for a shared store computer).
 */
export const useSession = create<SessionState>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setSession: (token, user) => set({ token, user }),
      clear: () => set({ token: null, user: null }),
    }),
    { name: 'quickhub-session', storage: createJSONStorage(() => sessionStorage) },
  ),
);
