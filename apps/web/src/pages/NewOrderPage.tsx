import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useFieldArray, useForm, useWatch } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { createOrderSchema, type CreateOrderInput } from '@quickhub/shared';
import { keys, useCreateOrder, useInventory } from '../api/queries';
import { ApiError, errorMessage } from '../lib/api';
import { money } from '../lib/format';
import { useUi } from '../stores/ui';

const STEPS = ['Customer', 'Items', 'Review'] as const;
const CUSTOMER_FIELDS = ['customerName', 'phone', 'address'] as const;
const MAX_QTY = 20;

export default function NewOrderPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((s) => s.toast);
  const inventory = useInventory();
  const createOrder = useCreateOrder();
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  // One key for this form. If the request is sent twice (double click, retry
  // after a timeout), the server recognises the key and creates only one order.
  const idempotencyKey = useRef(crypto.randomUUID());
  const done = useRef(false);

  const { register, control, handleSubmit, trigger, setError, clearErrors, formState } = useForm<CreateOrderInput>({
    resolver: zodResolver(createOrderSchema),
    mode: 'onTouched',
    defaultValues: { customerName: '', phone: '', address: '', items: [] },
  });
  const lines = useFieldArray({ control, name: 'items' });
  const items = useWatch({ control, name: 'items' });
  const customer = useWatch({ control });
  const { errors, isDirty } = formState;

  const bySku = useMemo(() => new Map(inventory.data?.map((i) => [i.sku, i])), [inventory.data]);
  const total = items.reduce((sum, line) => sum + (bySku.get(line.sku)?.price ?? 0) * line.qty, 0);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = inventory.data ?? [];
    return (q ? all.filter((i) => i.name.toLowerCase().includes(q) || i.sku.toLowerCase().includes(q)) : all).slice(0, 30);
  }, [inventory.data, search]);

  // Warn before losing typed data on refresh/close.
  useEffect(() => {
    if (!isDirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      if (!done.current) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  function addItem(sku: string) {
    setFormError(null);
    const index = items.findIndex((line) => line.sku === sku);
    // Adding the same item again raises its quantity instead of making a second line.
    if (index >= 0) lines.update(index, { sku, qty: Math.min(MAX_QTY, items[index]!.qty + 1) });
    else lines.append({ sku, qty: 1 });
    clearErrors('items');
  }

  function setQty(index: number, qty: number) {
    if (qty < 1) lines.remove(index);
    else lines.update(index, { sku: items[index]!.sku, qty: Math.min(MAX_QTY, qty) });
  }

  /** Compare the cart with the stock we currently know about. */
  function stockProblems(): boolean {
    let bad = false;
    items.forEach((line, i) => {
      const available = bySku.get(line.sku)?.stock ?? 0;
      if (line.qty > available) {
        bad = true;
        setError(`items.${i}.qty`, { type: 'stock', message: available === 0 ? 'Out of stock' : `Only ${available} left` });
      }
    });
    return bad;
  }

  /** Validate only the fields of the current step before moving on. */
  async function next() {
    setFormError(null);
    if (step === 0 && (await trigger(CUSTOMER_FIELDS))) setStep(1);
    if (step === 1 && (await trigger('items')) && !stockProblems()) setStep(2);
  }

  const submit = handleSubmit((input) => {
    if (stockProblems()) return setStep(1);
    createOrder.mutate(
      { input, idempotencyKey: idempotencyKey.current },
      {
        onSuccess: (order) => {
          done.current = true;
          toast('success', `${order.id} created`);
          navigate(`/orders/${order.id}`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === 'insufficient_stock') {
            // Stock ran out between opening the form and submitting it.
            for (const short of err.body.shortages ?? []) {
              const i = items.findIndex((line) => line.sku === short.sku);
              if (i >= 0) setError(`items.${i}.qty`, { type: 'server', message: short.available === 0 ? 'Out of stock' : `Only ${short.available} left` });
            }
            void queryClient.invalidateQueries({ queryKey: keys.inventory });
            setFormError('Some items no longer have enough stock. Adjust the quantities.');
            setStep(1);
          } else if (err instanceof ApiError && err.code === 'validation' && err.body.fields) {
            // Put each server message next to its field and go to the step that shows it.
            const fields = Object.entries(err.body.fields);
            for (const [name, message] of fields) setError(name as keyof CreateOrderInput, { type: 'server', message });
            setStep(fields.some(([name]) => (CUSTOMER_FIELDS as readonly string[]).includes(name)) ? 0 : 1);
          } else {
            setFormError(errorMessage(err));
          }
        },
      },
    );
  });

  function onSubmit(e: FormEvent) {
    // Enter key or the main button: "Next" on steps 1-2, real submit on the last step.
    if (step < 2) {
      e.preventDefault();
      void next();
    } else {
      void submit(e);
    }
  }

  const itemsError = errors.items?.root?.message ?? errors.items?.message;

  return (
    <div className="page narrow">
      <h1>New order</h1>
      <ol className="stepper" aria-label="Progress">
        {STEPS.map((label, i) => (
          <li key={label} className={i === step ? 'current' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined}>
            <span>{i + 1}</span> {label}
          </li>
        ))}
      </ol>

      <form className="card" onSubmit={onSubmit} noValidate>
        {step === 0 && (
          <fieldset>
            <legend>Customer details</legend>
            <label className="field">
              <span>Name</span>
              <input autoFocus autoComplete="off" aria-invalid={!!errors.customerName} {...register('customerName')} />
              {errors.customerName && <em role="alert">{errors.customerName.message}</em>}
            </label>
            <label className="field">
              <span>Mobile number</span>
              <input inputMode="numeric" maxLength={10} autoComplete="off" aria-invalid={!!errors.phone} {...register('phone')} />
              {errors.phone && <em role="alert">{errors.phone.message}</em>}
            </label>
            <label className="field">
              <span>Delivery address</span>
              <textarea rows={3} aria-invalid={!!errors.address} {...register('address')} />
              {errors.address && <em role="alert">{errors.address.message}</em>}
            </label>
          </fieldset>
        )}

        {step === 1 && (
          <fieldset>
            <legend>Items</legend>
            {lines.fields.length > 0 && (
              <ul className="cart">
                {lines.fields.map((field, i) => {
                  const line = items[i];
                  if (!line) return null;
                  const item = bySku.get(line.sku);
                  const error = errors.items?.[i]?.qty?.message;
                  return (
                    <li key={field.id} data-testid="cart-line">
                      <span className="ellipsis">{item?.name ?? line.sku}</span>
                      <span className="qty">
                        <button type="button" className="btn" aria-label={`Decrease ${item?.name}`} onClick={() => setQty(i, line.qty - 1)}>
                          −
                        </button>
                        <output aria-label="Quantity">{line.qty}</output>
                        <button type="button" className="btn" aria-label={`Increase ${item?.name}`} disabled={line.qty >= MAX_QTY} onClick={() => setQty(i, line.qty + 1)}>
                          +
                        </button>
                      </span>
                      <span className="num">{money((item?.price ?? 0) * line.qty)}</span>
                      {error && <em role="alert">{error}</em>}
                    </li>
                  );
                })}
              </ul>
            )}
            {itemsError && <em role="alert">{itemsError}</em>}

            <input
              type="search"
              className="search block"
              placeholder="Search items to add"
              aria-label="Search items to add"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              // Enter here should search, not move to the next step.
              onKeyDown={(e) => e.key === 'Enter' && e.preventDefault()}
            />
            <ul className="picker" aria-label="Available items">
              {inventory.isPending && <li className="muted">Loading items…</li>}
              {inventory.isError && <li role="alert">Could not load items.</li>}
              {matches.map((item) => (
                <li key={item.sku}>
                  <span className="ellipsis">
                    {item.name} <small className="muted">{item.stock} in stock</small>
                  </span>
                  <span className="num">{money(item.price)}</span>
                  <button type="button" className="btn" disabled={item.stock === 0} onClick={() => addItem(item.sku)}>
                    {item.stock === 0 ? 'Out of stock' : 'Add'}
                  </button>
                </li>
              ))}
              {inventory.data && matches.length === 0 && <li className="muted">No items match.</li>}
            </ul>
          </fieldset>
        )}

        {step === 2 && (
          <fieldset>
            <legend>Review</legend>
            <dl className="facts">
              <dt>Customer</dt>
              <dd>{customer.customerName}</dd>
              <dt>Phone</dt>
              <dd>{customer.phone}</dd>
              <dt>Address</dt>
              <dd>{customer.address}</dd>
            </dl>
            <table className="items">
              <tbody>
                {items.map((line) => {
                  const item = bySku.get(line.sku);
                  return (
                    <tr key={line.sku}>
                      <td>{item?.name ?? line.sku}</td>
                      <td className="num">× {line.qty}</td>
                      <td className="num">{money((item?.price ?? 0) * line.qty)}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={2}>Total</th>
                  <th className="num">{money(total)}</th>
                </tr>
              </tfoot>
            </table>
          </fieldset>
        )}

        {formError && (
          <p className="form-error" role="alert">
            {formError}
          </p>
        )}

        <div className="form-nav">
          {step > 0 && (
            <button type="button" className="btn" disabled={createOrder.isPending} onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step === 1 && items.length > 0 && <span className="muted">Total {money(total)}</span>}
          <button type="submit" className="btn primary" disabled={createOrder.isPending}>
            {step < 2 ? 'Next' : createOrder.isPending ? 'Creating…' : 'Create order'}
          </button>
        </div>
      </form>
    </div>
  );
}
