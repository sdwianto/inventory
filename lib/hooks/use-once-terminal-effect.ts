'use client';

import { useEffect, useRef } from 'react';

/** Jalankan callback sekali saat status terminal tercapai — setState via queueMicrotask (eslint-safe). */
export function useOnceTerminalEffect<T>(
  token: string | null | undefined,
  data: T | null | undefined,
  status: string | null | undefined,
  terminal: readonly string[],
  onMatch: (matchedStatus: string, data: T) => void,
) {
  const seenRef = useRef<string | null>(null);
  const onMatchRef = useRef(onMatch);

  useEffect(() => {
    onMatchRef.current = onMatch;
  });

  useEffect(() => {
    if (!token || !data || !status) return;
    if (!terminal.includes(status)) return;
    const key = `${token}:${status}`;
    if (seenRef.current === key) return;
    seenRef.current = key;
    queueMicrotask(() => onMatchRef.current(status, data));
  }, [token, data, status, terminal]);
}
