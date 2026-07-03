/**
 * Throttle prefetch agar tidak membanjiri API saat hover/expand sidebar.
 */
import type { QueryClient } from '@tanstack/react-query';

const MAX_CONCURRENT = 3;
const DEBOUNCE_MS = 150;

let inFlight = 0;
const waitQueue: Array<() => void> = [];
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function drainQueue() {
  while (inFlight < MAX_CONCURRENT && waitQueue.length > 0) {
    const next = waitQueue.shift();
    if (!next) break;
    inFlight += 1;
    try {
      next();
    } finally {
      inFlight -= 1;
      drainQueue();
    }
  }
}

export function shouldSkipPrefetch(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return Boolean(conn?.saveData);
}

export function schedulePrefetch(task: () => void): void {
  if (shouldSkipPrefetch()) return;
  waitQueue.push(task);
  drainQueue();
}

export function debouncedPrefetch(href: string, task: () => void): void {
  if (shouldSkipPrefetch()) return;
  const prev = debounceTimers.get(href);
  if (prev) clearTimeout(prev);
  debounceTimers.set(
    href,
    setTimeout(() => {
      debounceTimers.delete(href);
      schedulePrefetch(task);
    }, DEBOUNCE_MS),
  );
}

export function prefetchNavGroupThrottled(
  queryClient: QueryClient,
  hrefs: string[],
  prefetchOne: (qc: QueryClient, href: string) => void,
  { max = 3 }: { max?: number } = {},
) {
  if (shouldSkipPrefetch()) return;
  for (const href of hrefs.slice(0, max)) {
    schedulePrefetch(() => prefetchOne(queryClient, href));
  }
}
