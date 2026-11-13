# Walkthrough: read the code in this order

The goal is that you can explain every file. Read in this order, run the app next to it,
and try to answer the questions without looking. If you can, you own that part.

## 1. `packages/shared/src/index.ts` (start here)
The vocabulary of the whole project: `Order`, the status state machine, permissions.
- Why does this live in a shared package instead of in the web app?
- What is the difference between `roleAllowsStatus`, `checkTransition` and `canChangeStatus`?
- Why does `Order` have a `version` field?

## 2. `apps/server/src/store.ts` and `app.ts`
The fake backend. `store.ts` holds the data and rules, `app.ts` maps URLs to store calls.
- How does cursor pagination work in `listOrders`, and why not page numbers?
- What happens when two requests update the same order with the same `version`?
- Where is the picker restricted to their own orders? Why is hiding it in the UI not enough?
- What does the `Idempotency-Key` header protect against?

## 3. `apps/server/src/realtime.ts`
- Why is the token sent as the first message rather than in the URL?
- Why does each connection have its own `seq` counter?
- When does a picker receive `order.removed`?

## 4. `apps/web/src/lib/api.ts`, `stores/session.ts`, `components/guards.tsx`
Login, the fetch wrapper, and route protection.
- What happens, step by step, when any request returns 401?
- Why sessionStorage?

## 5. `apps/web/src/api/queries.ts`
All data fetching. The most important file to understand on the web side.
- What is a query key, and why are they all defined in `keys`?
- Walk through `useUpdateStatus`: what do `onMutate`, `onSuccess` and `onError` each do?
- On an error, why do we refetch the order instead of restoring our old snapshot?

## 6. `apps/web/src/realtime/` (socket.ts, applyEvents.ts, useRealtime.ts)
- `socket.ts`: list every reason the client reconnects. Why is there jitter in the backoff?
- Why are events buffered for 250 ms?
- `applyEvents.ts`: go through each test in `applyEvents.test.ts` and explain why that behaviour is right.
- Why must `applyOrderChanges` return the same object when nothing changed?

## 7. `apps/web/src/components/OrdersTable.tsx`
- What does the virtualizer do? How many rows are in the DOM for 10,000 orders?
- What problem does "scroll anchoring" solve? Try removing the `useLayoutEffect` and watch what happens.
- Why is `OrderRow` wrapped in `memo`?

## 8. `components/OrderDrawer.tsx`, `pages/NewOrderPage.tsx`, `pages/InventoryPage.tsx`
- How does the drawer decide which action buttons to show, disable or hide?
- In the form, how is only the current step validated?
- What happens if stock runs out between step 2 and submit?

## Things to try yourself (good first changes)
1. Add a "Late only" filter chip (server query param + shared `matchesOrderFilter` + UI).
2. Add sorting by promise time.
3. Show a small timeline of status changes in the drawer (the server would need to store history).
4. Add keyboard navigation (arrow keys) between table rows.
5. Write a Playwright test for the 409 conflict flow using two manager sessions.

Building one or two of these on your own is the best proof the project is yours.
