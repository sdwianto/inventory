'use client';

import { useEffect, useState } from 'react';
import { WifiOff, CloudUpload } from 'lucide-react';
import { toast } from 'sonner';
import {
  countPendingMutations,
  replayOfflineMutations,
} from '@/lib/offline-mutation-queue';

export default function OfflineIndicator() {
  const [online, setOnline] = useState(true);
  const [pending, setPending] = useState(0);

  const refreshPending = () => {
    void countPendingMutations().then(setPending).catch(() => setPending(0));
  };

  useEffect(() => {
    if (typeof navigator !== 'undefined') setOnline(navigator.onLine);
    refreshPending();

    const handleOnline = () => {
      setOnline(true);
      void (async () => {
        const { ok, failed } = await replayOfflineMutations();
        refreshPending();
        if (ok > 0) toast.success(`${ok} perubahan offline disinkronkan`);
        if (failed > 0) toast.error(`${failed} perubahan gagal disinkron — coba lagi`);
      })();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const onQueued = () => refreshPending();
    window.addEventListener('erp-offline-queued', onQueued);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('erp-offline-queued', onQueued);
    };
  }, []);

  if (online && pending === 0) return null;

  return (
    <div className={`fixed top-0 left-0 right-0 text-white text-center py-1.5 text-sm font-medium z-50 flex items-center justify-center gap-2 no-print ${online ? 'bg-amber-600' : 'bg-red-600'}`}>
      {online ? <CloudUpload className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
      {online
        ? `${pending} perubahan menunggu sinkron…`
        : 'Offline — perubahan akan disinkron saat kembali online'}
    </div>
  );
}
