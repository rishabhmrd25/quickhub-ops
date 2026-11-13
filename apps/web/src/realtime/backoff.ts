/**
 * How long to wait before reconnect attempt number `attempt` (0-based).
 * Doubles each time (1s, 2s, 4s ... capped at 30s) with random "jitter",
 * so that after a server restart all browsers don't reconnect at the same instant.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 10));
  return Math.round(ceiling * (0.5 + random() * 0.5));
}
