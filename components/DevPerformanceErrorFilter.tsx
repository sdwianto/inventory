'use client';

import { useEffect } from 'react';

/** Suppresses benign PerformanceServerTiming DataCloneError noise in dev tools. */
export default function DevPerformanceErrorFilter() {
  useEffect(() => {
    const onError = (e) => {
      if (
        e.error instanceof DOMException &&
        e.error.name === 'DataCloneError' &&
        e.message?.includes('PerformanceServerTiming')
      ) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };
    window.addEventListener('error', onError, true);
    return () => window.removeEventListener('error', onError, true);
  }, []);
  return null;
}
