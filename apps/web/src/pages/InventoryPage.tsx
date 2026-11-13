import { memo, useMemo, useState } from 'react';
import { isLowStock, type InventoryItem } from '@quickhub/shared';
import { useAdjustStock, useInventory } from '../api/queries';
import { errorMessage } from '../lib/api';
import { count, money } from '../lib/format';
import { useCan, useDebouncedValue } from '../lib/hooks';

export default function InventoryPage() {
  const inventory = useInventory();
  const canAdjust = useCan('inventory:adjust');
  const [search, setSearch] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const q = useDebouncedValue(search.trim().toLowerCase(), 200);

  // The whole list (a few hundred rows) is loaded once and filtered in the
  // browser. Live stock updates then only need to patch one cached list.
  const rows = useMemo(() => {
    const all = inventory.data ?? [];
    return all.filter(
      (it) =>
        (!lowOnly || isLowStock(it)) &&
        (!q || it.name.toLowerCase().includes(q) || it.sku.toLowerCase().includes(q) || it.category.toLowerCase().includes(q)),
    );
  }, [inventory.data, q, lowOnly]);
  const lowCount = useMemo(() => (inventory.data ?? []).filter(isLowStock).length, [inventory.data]);

  return (
    <div className="page">
      <div className="toolbar">
        <h1>Inventory</h1>
        <div className="toolbar-right">
          <label className="check">
            <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
            Low stock only <b>{count(lowCount)}</b>
          </label>
          <input
            type="search"
            className="search"
            placeholder="Search item, SKU, category"
            aria-label="Search inventory"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {inventory.isPending ? (
        <div className="table-state" role="status">
          Loading inventory…
        </div>
      ) : inventory.isError ? (
        <div className="table-state" role="alert">
          <p>Could not load inventory: {errorMessage(inventory.error)}</p>
          <button className="btn primary" onClick={() => inventory.refetch()}>
            Retry
          </button>
        </div>
      ) : rows.length === 0 ? (
        <div className="table-state">No items match.</div>
      ) : (
        <div className="plain-table-wrap">
          <table className="plain-table">
            <thead>
              <tr>
                <th>SKU</th>
                <th>Item</th>
                <th>Category</th>
                <th className="num">Price</th>
                <th className="num">Reorder at</th>
                <th className="num">In stock</th>
                {canAdjust && <th>Adjust stock</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <InventoryRow key={item.sku} item={item} canAdjust={canAdjust} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const InventoryRow = memo(function InventoryRow({ item, canAdjust }: { item: InventoryItem; canAdjust: boolean }) {
  const adjust = useAdjustStock();
  const [raw, setRaw] = useState('');
  const delta = Number(raw);
  const valid = raw.trim() !== '' && Number.isInteger(delta) && delta !== 0;
  const belowZero = valid && item.stock + delta < 0;

  return (
    <tr data-testid="inventory-row" data-sku={item.sku}>
      <td className="muted">{item.sku}</td>
      <td>{item.name}</td>
      <td className="muted">{item.category}</td>
      <td className="num">{money(item.price)}</td>
      <td className="num muted">{item.reorderLevel}</td>
      <td className="num">
        <span data-testid="stock">{item.stock}</span> {isLowStock(item) && <span className="badge low">Low</span>}
      </td>
      {canAdjust && (
        <td>
          <form
            className="adjust"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || belowZero) return;
              adjust.mutate({ item, delta }, { onSuccess: () => setRaw('') });
            }}
          >
            <input
              type="number"
              step={1}
              placeholder="+10 / -5"
              aria-label={`Change stock of ${item.name} by`}
              aria-invalid={belowZero}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
            />
            <button className="btn" type="submit" disabled={!valid || belowZero || adjust.isPending}>
              {adjust.isPending ? 'Saving…' : 'Apply'}
            </button>
            {belowZero && <em role="alert">Only {item.stock} in stock</em>}
          </form>
        </td>
      )}
    </tr>
  );
});
