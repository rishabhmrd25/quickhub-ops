const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const money = (n: number) => inr.format(n);

const time = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit' });
const dateTime = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const clock = (ts: number) => time.format(ts);
export const stamp = (ts: number) => dateTime.format(ts);

/** "45s", "12m", "3h", "2d" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export const count = (n: number) => n.toLocaleString('en-IN');
