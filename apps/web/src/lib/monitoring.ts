/**
 * Error reporting + Core Web Vitals.
 * Both SDKs are loaded with dynamic import(), so they are separate chunks and
 * cost nothing on first paint. Sentry only loads if a DSN is configured.
 */
type Sentry = typeof import('@sentry/react');
let sentry: Sentry | null = null;

export async function initMonitoring() {
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (dsn) {
    sentry = await import('@sentry/react');
    sentry.init({ dsn, environment: import.meta.env.MODE, tracesSampleRate: 0.1 });
  }

  const { onCLS, onINP, onLCP } = await import('web-vitals');
  const report = (metric: { name: string; value: number; rating: string }) => {
    if (import.meta.env.DEV) console.debug(`[web-vitals] ${metric.name}`, Math.round(metric.value), metric.rating);
    sentry?.addBreadcrumb({ category: 'web-vitals', message: `${metric.name}=${metric.value}`, level: 'info' });
  };
  onCLS(report);
  onINP(report);
  onLCP(report);
}

export function reportError(error: unknown, context?: Record<string, unknown>) {
  console.error(error, context ?? '');
  sentry?.captureException(error, { extra: context });
}
