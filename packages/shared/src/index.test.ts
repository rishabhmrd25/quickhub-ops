import { describe, expect, it } from 'vitest';
import {
  can,
  canChangeStatus,
  canSeeOrder,
  checkTransition,
  createOrderSchema,
  isLate,
  type User,
} from './index';

const manager: User = { id: 'u-m', name: 'M', email: 'm@x.dev', role: 'manager' };
const picker: User = { id: 'p-1', name: 'P', email: 'p@x.dev', role: 'picker' };
const viewer: User = { id: 'u-v', name: 'V', email: 'v@x.dev', role: 'viewer' };

describe('order state machine', () => {
  it('allows the normal forward path', () => {
    expect(checkTransition({ status: 'new', pickerId: 'p-1', riderId: null }, 'picking').ok).toBe(true);
    expect(checkTransition({ status: 'picking', pickerId: 'p-1', riderId: null }, 'packed').ok).toBe(true);
    expect(checkTransition({ status: 'packed', pickerId: 'p-1', riderId: 'r-1' }, 'out_for_delivery').ok).toBe(true);
    expect(checkTransition({ status: 'out_for_delivery', pickerId: 'p-1', riderId: 'r-1' }, 'delivered').ok).toBe(true);
  });

  it('blocks skipping a step and moving backwards', () => {
    expect(checkTransition({ status: 'new', pickerId: 'p-1', riderId: null }, 'packed').ok).toBe(false);
    expect(checkTransition({ status: 'packed', pickerId: 'p-1', riderId: null }, 'picking').ok).toBe(false);
  });

  it('needs a picker before picking and a rider before dispatch', () => {
    expect(checkTransition({ status: 'new', pickerId: null, riderId: null }, 'picking')).toEqual({
      ok: false,
      reason: 'Assign a picker first',
    });
    expect(checkTransition({ status: 'packed', pickerId: 'p-1', riderId: null }, 'out_for_delivery').ok).toBe(false);
  });

  it('cannot cancel once out for delivery, and final states are final', () => {
    expect(checkTransition({ status: 'out_for_delivery', pickerId: 'p', riderId: 'r' }, 'cancelled').ok).toBe(false);
    expect(checkTransition({ status: 'delivered', pickerId: 'p', riderId: 'r' }, 'cancelled').ok).toBe(false);
    expect(checkTransition({ status: 'cancelled', pickerId: null, riderId: null }, 'new').ok).toBe(false);
  });
});

describe('permissions', () => {
  it('only managers can create orders and adjust stock', () => {
    expect(can('manager', 'orders:create')).toBe(true);
    expect(can('picker', 'orders:create')).toBe(false);
    expect(can('viewer', 'inventory:adjust')).toBe(false);
  });

  it('pickers only see their own orders', () => {
    expect(canSeeOrder(picker, { pickerId: 'p-1' })).toBe(true);
    expect(canSeeOrder(picker, { pickerId: 'p-2' })).toBe(false);
    expect(canSeeOrder(viewer, { pickerId: 'p-2' })).toBe(true);
  });

  it('pickers can pick and pack their own orders, nothing else', () => {
    const mine = { status: 'new' as const, pickerId: 'p-1', riderId: null };
    expect(canChangeStatus(picker, mine, 'picking').ok).toBe(true);
    expect(canChangeStatus(picker, mine, 'cancelled').ok).toBe(false);
    expect(canChangeStatus(picker, { ...mine, pickerId: 'p-2' }, 'picking').ok).toBe(false);
  });

  it('viewers can never change status; managers follow the state machine', () => {
    const o = { status: 'new' as const, pickerId: 'p-1', riderId: null };
    expect(canChangeStatus(viewer, o, 'picking').ok).toBe(false);
    expect(canChangeStatus(manager, o, 'picking').ok).toBe(true);
    expect(canChangeStatus(manager, o, 'delivered').ok).toBe(false);
  });
});

describe('helpers and schemas', () => {
  it('flags late orders only while they are still open', () => {
    expect(isLate({ status: 'picking', promisedBy: 100 }, 200)).toBe(true);
    expect(isLate({ status: 'delivered', promisedBy: 100 }, 200)).toBe(false);
    expect(isLate({ status: 'picking', promisedBy: 300 }, 200)).toBe(false);
  });

  it('validates a new order', () => {
    const good = {
      customerName: 'Asha Rao',
      phone: '9876543210',
      address: '12, 4th Cross, Indiranagar',
      items: [{ sku: 'SKU-0001', qty: 2 }],
    };
    expect(createOrderSchema.safeParse(good).success).toBe(true);
    expect(createOrderSchema.safeParse({ ...good, phone: '12345' }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...good, items: [] }).success).toBe(false);
    expect(createOrderSchema.safeParse({ ...good, items: [{ sku: 'SKU-0001', qty: 0 }] }).success).toBe(false);
  });
});
