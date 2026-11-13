import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  CreateOrderInput,
  InventoryItem,
  Order,
  OrderFilter,
  OrdersPage,
  OrderStats,
  OrderStatus,
  StaffMember,
  User,
} from '@quickhub/shared';
import { api, ApiError, errorMessage } from '../lib/api';
import { applyInventoryUpdates, applyOrderChanges, type OrderChange, type OrdersData } from '../realtime/applyEvents';
import { useUi } from '../stores/ui';

/** All cache keys in one place, so invalidation never relies on typing a string right. */
export const keys = {
  me: ['me'] as const,
  orders: ['orders'] as const,
  orderLists: ['orders', 'list'] as const,
  orderList: (filter: OrderFilter) => ['orders', 'list', filter] as const,
  orderDetail: (id: string) => ['orders', 'detail', id] as const,
  stats: ['stats'] as const,
  inventory: ['inventory'] as const,
  staff: ['staff'] as const,
};

const PAGE_SIZE = 200;

/* ------------------------------ queries ------------------------------ */

export const useMe = () =>
  useQuery({ queryKey: keys.me, queryFn: ({ signal }) => api<User>('/api/me', { signal }), staleTime: Infinity });

export function useOrders(filter: OrderFilter) {
  return useInfiniteQuery({
    queryKey: keys.orderList(filter),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (filter.status) params.set('status', filter.status);
      if (filter.q) params.set('q', filter.q);
      if (pageParam) params.set('cursor', pageParam);
      return api<OrdersPage>(`/api/orders?${params}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // The WebSocket keeps loaded pages fresh, so there is no need to refetch
    // every page on window focus. A reconnect/gap triggers an explicit refetch.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useOrder(id: string | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: keys.orderDetail(id ?? ''),
    queryFn: ({ signal }) => api<Order>(`/api/orders/${id}`, { signal }),
    enabled: !!id,
    // Show the copy from the table instantly while the full fetch runs.
    initialData: () => (id ? findOrderInLists(queryClient, id) : undefined),
    initialDataUpdatedAt: 0,
  });
}

export const useStats = () =>
  useQuery({ queryKey: keys.stats, queryFn: ({ signal }) => api<OrderStats>('/api/stats', { signal }), placeholderData: keepPreviousData });

export const useInventory = () =>
  useQuery({ queryKey: keys.inventory, queryFn: ({ signal }) => api<InventoryItem[]>('/api/inventory', { signal }) });

export const useStaff = () =>
  useQuery({ queryKey: keys.staff, queryFn: ({ signal }) => api<StaffMember[]>('/api/staff', { signal }), staleTime: Infinity });

/* --------------------------- cache helpers --------------------------- */

function findOrderInLists(queryClient: QueryClient, id: string): Order | undefined {
  for (const [, data] of queryClient.getQueriesData<OrdersData>({ queryKey: keys.orderLists })) {
    for (const page of data?.pages ?? []) {
      const hit = page.items.find((o) => o.id === id);
      if (hit) return hit;
    }
  }
  return undefined;
}

/** Push order changes into every cached list (each has its own filter) and the detail entries. */
export function patchOrders(queryClient: QueryClient, changes: OrderChange[]) {
  if (changes.length === 0) return;
  for (const [key, data] of queryClient.getQueriesData<OrdersData>({ queryKey: keys.orderLists })) {
    if (!data) continue;
    const next = applyOrderChanges(data, key[2] as OrderFilter, changes);
    if (next !== data) queryClient.setQueryData(key, next);
  }
  for (const change of changes) {
    if (change.kind === 'remove') {
      queryClient.removeQueries({ queryKey: keys.orderDetail(change.orderId) });
      continue;
    }
    const key = keys.orderDetail(change.order.id);
    if (!queryClient.getQueryState(key)) continue; // nobody has opened this order
    queryClient.setQueryData<Order>(key, (old) =>
      !old || change.force || change.order.version > old.version ? change.order : old,
    );
  }
}

/* ----------------------------- mutations ----------------------------- */

export function useUpdateStatus() {
  const queryClient = useQueryClient();
  const toast = useUi((s) => s.toast);

  return useMutation({
    mutationFn: ({ order, status }: { order: Order; status: OrderStatus }) =>
      api<Order>(`/api/orders/${order.id}/status`, { method: 'PATCH', body: { status, version: order.version } }),

    // Optimistic update: change the screen first, ask the server second.
    onMutate: async ({ order, status }) => {
      await queryClient.cancelQueries({ queryKey: keys.orderDetail(order.id) });
      patchOrders(queryClient, [{ kind: 'upsert', order: { ...order, status }, force: true }]);
    },
    onSuccess: (saved) => patchOrders(queryClient, [{ kind: 'upsert', order: saved, force: true }]),
    onError: async (err, { order }) => {
      if (err instanceof ApiError && err.status === 409 && err.body.current) {
        // Someone else changed it first. The server sent us the latest copy.
        patchOrders(queryClient, [{ kind: 'upsert', order: err.body.current as Order, force: true }]);
        toast('info', `${order.id} was changed by someone else. Showing the latest.`);
        return;
      }
      toast('error', errorMessage(err));
      // Undo the optimistic change using the server's copy, not our old snapshot,
      // because a live update may have arrived in the meantime.
      try {
        const fresh = await api<Order>(`/api/orders/${order.id}`);
        patchOrders(queryClient, [{ kind: 'upsert', order: fresh, force: true }]);
      } catch (refetchError) {
        const gone = refetchError instanceof ApiError && refetchError.status === 404;
        patchOrders(queryClient, [gone ? { kind: 'remove', orderId: order.id } : { kind: 'upsert', order, force: true }]);
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: keys.stats }),
  });
}

export function useAssign() {
  const queryClient = useQueryClient();
  const toast = useUi((s) => s.toast);

  return useMutation({
    mutationFn: ({ order, change }: { order: Order; change: { pickerId?: string | null; riderId?: string | null } }) =>
      api<Order>(`/api/orders/${order.id}/assign`, { method: 'PATCH', body: { ...change, version: order.version } }),
    onSuccess: (saved) => patchOrders(queryClient, [{ kind: 'upsert', order: saved, force: true }]),
    onError: (err, { order }) => {
      if (err instanceof ApiError && err.status === 409 && err.body.current) {
        patchOrders(queryClient, [{ kind: 'upsert', order: err.body.current as Order, force: true }]);
        toast('info', `${order.id} was changed by someone else. Showing the latest.`);
      } else {
        toast('error', errorMessage(err));
      }
    },
  });
}

export function useCreateOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, idempotencyKey }: { input: CreateOrderInput; idempotencyKey: string }) =>
      api<Order>('/api/orders', { method: 'POST', body: input, headers: { 'Idempotency-Key': idempotencyKey } }),
    onSuccess: (order) => {
      patchOrders(queryClient, [{ kind: 'upsert', order }]);
      void queryClient.invalidateQueries({ queryKey: keys.stats });
      void queryClient.invalidateQueries({ queryKey: keys.inventory });
    },
    // Errors are handled by the form, which needs to map them onto fields.
  });
}

export function useAdjustStock() {
  const queryClient = useQueryClient();
  const toast = useUi((s) => s.toast);
  const apply = (item: InventoryItem) =>
    queryClient.setQueryData<InventoryItem[]>(keys.inventory, (old) => old && applyInventoryUpdates(old, [item]));

  return useMutation({
    mutationFn: ({ item, delta }: { item: InventoryItem; delta: number }) =>
      api<InventoryItem>(`/api/inventory/${item.sku}`, { method: 'PATCH', body: { delta, version: item.version } }),
    onSuccess: (saved) => {
      apply(saved);
      toast('success', `${saved.name}: stock is now ${saved.stock}`);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409 && err.body.current) {
        apply(err.body.current as InventoryItem);
        toast('info', 'Stock changed while you were editing. Showing the latest, please try again.');
      } else {
        toast('error', errorMessage(err));
      }
    },
  });
}
