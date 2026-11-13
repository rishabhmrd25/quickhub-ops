import type { Order } from '@quickhub/shared';
import type { Store } from './store';

/**
 * Pretends to be a busy store: new orders arrive and existing ones move forward.
 * It goes through the same store methods as the API, so it obeys the same rules.
 */
export function startSimulator(store: Store, tickMs = 1500) {
  const pickers = store.staff.filter((s) => s.kind === 'picker');
  const riders = store.staff.filter((s) => s.kind === 'rider');
  const any = <T>(list: T[]) => list[Math.floor(store.random() * list.length)]!;

  function advance(order: Order) {
    switch (order.status) {
      case 'new':
        if (store.random() < 0.03) return void store.setStatus(order.id, 'cancelled', null, null);
        if (!order.pickerId) return void store.assign(order.id, { pickerId: any(pickers).id }, null, false);
        return void store.setStatus(order.id, 'picking', null, null);
      case 'picking':
        return void store.setStatus(order.id, 'packed', null, null);
      case 'packed':
        if (!order.riderId) return void store.assign(order.id, { riderId: any(riders).id }, null, false);
        return void store.setStatus(order.id, 'out_for_delivery', null, null);
      case 'out_for_delivery':
        return void store.setStatus(order.id, 'delivered', null, null);
    }
  }

  const timer = setInterval(() => {
    try {
      // Leave orders alone if a person just edited them, so the demo isn't a fight.
      const open = store.openOrders().filter((o) => !store.wasTouchedRecently(o.id));
      const moves = open.length > 160 ? 3 : 1;
      for (let i = 0; i < moves && open.length > 0; i++) advance(any(open));

      const createChance = open.length < 80 ? 0.6 : 0.22;
      if (store.random() < createChance) {
        const skus = store.randomInStockSkus(1 + Math.floor(store.random() * 4));
        if (skus.length > 0) {
          store.createOrder({
            ...store.randomCustomer(),
            items: skus.map((sku) => ({ sku, qty: 1 + Math.floor(store.random() * 2) })),
          });
        }
      }
    } catch (err) {
      // A simulator hiccup must never take the server down.
      console.warn('simulator:', (err as Error).message);
    }
  }, tickMs);

  return () => clearInterval(timer);
}
