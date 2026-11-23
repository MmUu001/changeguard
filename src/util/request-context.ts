/**
 * Request-scoped context via AsyncLocalStorage.
 *
 * The HTTP entry point wraps each request in `runWithRequestContext`, so every
 * logger call made while handling it — including async continuations and scans
 * enqueued from the request — automatically carries requestId / tenantId
 * without threading parameters through 47 call sites.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
  /** Filled in by auth resolution once the tenant is known (best-effort). */
  tenantId?: string;
  actor?: string;
  method?: string;
  path?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** Mutate the current context in place (no-op outside a request scope). */
export function setRequestContextFields(fields: Partial<RequestContext>): void {
  const ctx = storage.getStore();
  if (ctx) Object.assign(ctx, fields);
}
