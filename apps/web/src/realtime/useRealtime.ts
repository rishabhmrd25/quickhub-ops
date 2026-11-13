import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { InventoryItem } from '@quickhub/shared';
import { keys, patchOrders } from '../api/queries';
import { wsUrl } from '../lib/api';
import { useSession } from '../stores/session';
import { useUi } from '../stores/ui';
import { applyInventoryUpdates, type OrderChange } from './applyEvents';
import { RealtimeClient } from './socket';

const STATS_REFRESH_MS = 3_000;

/** Connects the WebSocket to the TanStack Query cache. Mounted once, while signed in. */
export function useRealtime() {
  const queryClient = useQueryClient();
  const token = useSession((s) => s.token);

  useEffect(() => {
    if (!token) return;
    let statsTimer: ReturnType<typeof setTimeout> | null = null;

    const client = new RealtimeClient(wsUrl(), {
      getToken: () => useSession.getState().token,
      onStatus: (status) => useUi.getState().setConnection(status),
      onUnauthorized: () => useSession.getState().clear(),
      onResync: () => void queryClient.invalidateQueries(),
      onEvents: (events) => {
        const orderChanges: OrderChange[] = [];
        const stock: InventoryItem[] = [];
        for (const event of events) {
          if (event.type === 'inventory.updated') stock.push(...event.items);
          else if (event.type === 'order.removed') orderChanges.push({ kind: 'remove', orderId: event.orderId });
          else orderChanges.push({ kind: 'upsert', order: event.order });
        }

        patchOrders(queryClient, orderChanges);
        if (stock.length > 0) {
          queryClient.setQueryData<InventoryItem[]>(keys.inventory, (old) => old && applyInventoryUpdates(old, stock));
        }
        // The counters come from the server. Refresh them, but not on every single batch.
        if (orderChanges.length > 0 && !statsTimer) {
          statsTimer = setTimeout(() => {
            statsTimer = null;
            void queryClient.invalidateQueries({ queryKey: keys.stats });
          }, STATS_REFRESH_MS);
        }
      },
    });

    client.start();
    return () => {
      if (statsTimer) clearTimeout(statsTimer);
      client.stop();
    };
  }, [token, queryClient]);
}
