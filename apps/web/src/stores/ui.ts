import { create } from 'zustand';

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline';

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  message: string;
}

interface UiState {
  connection: ConnectionStatus;
  setConnection: (status: ConnectionStatus) => void;

  toasts: Toast[];
  toast: (kind: Toast['kind'], message: string) => void;
  dismissToast: (id: number) => void;
}

let nextToastId = 1;

/** Browser-only state. Anything that comes from the server lives in TanStack Query instead. */
export const useUi = create<UiState>((set, get) => ({
  connection: 'connecting',
  setConnection: (connection) => set({ connection }),

  toasts: [],
  toast: (kind, message) => {
    const id = nextToastId++;
    // Keep at most 4 on screen so a burst of errors can't cover the page.
    set({ toasts: [...get().toasts.slice(-3), { id, kind, message }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 6000 : 3500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
