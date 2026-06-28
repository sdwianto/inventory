'use client';

import { useCallback, useEffect, useRef } from 'react';

/** Debounce async/sync callback — default 300ms. */
export function useDebouncedCallback<T extends (...args: never[]) => void>(fn: T, delayMs = 300) {
  const fnRef = useRef(fn);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return useCallback((...args: Parameters<T>) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      fnRef.current(...args);
    }, delayMs);
  }, [delayMs]);
}
