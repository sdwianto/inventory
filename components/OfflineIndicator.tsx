'use client';

import { useCallback, useEffect, useState } from 'react';
import { WifiOff, CloudUpload, ChevronDown, ChevronUp, RotateCcw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  countPendingMutations,
  discardOfflineMutation,
  listPendingMutations,
  replayOfflineMutation,
  replayOfflineMutations,
  type OfflineMutation,
} from '@/lib/offline-mutation-queue';

function formatLabel(row: OfflineMutation) {
  if (row.label) return row.label;
  try {
    const path = new URL(row.url, window.location.origin).pathname;
    return `${row.method} ${path}`;
  } catch {
    return row.method;
  }
}

export default function OfflineIndicator() {
  const [online, setOnline] = useState(() => (
    typeof navigator !== 'undefined' ? navigator.onLine : true
  ));
  const [pending, setPending] = useState(0);
  const [items, setItems] = useState<OfflineMutation[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refreshPending = useCallback(() => {
    void countPendingMutations().then(setPending).catch(() => setPending(0));
    void listPendingMutations().then(setItems).catch(() => setItems([]));
  }, []);

  const showConflictToast = useCallback((detail: { id: string; label?: string; error: string }) => {
    const title = detail.label ? `Konflik: ${detail.label}` : 'Konflik sinkron offline';
    toast.error(title, {
      description: detail.error,
      duration: 12_000,
      action: {
        label: 'Coba lagi',
        onClick: () => {
          void (async () => {
            setBusyId(detail.id);
            const result = await replayOfflineMutation(detail.id);
            setBusyId(null);
            refreshPending();
            if (result === 'ok') toast.success('Berhasil disinkronkan');
            else if (result === 'conflict') toast.error('Masih konflik — periksa data');
            else if (result === 'failed') toast.error('Gagal sinkron — coba lagi');
          })();
        },
      },
      cancel: {
        label: 'Buang',
        onClick: () => {
          void discardOfflineMutation(detail.id).then(refreshPending);
        },
      },
    });
  }, [refreshPending]);

  useEffect(() => {
    refreshPending();

    const handleOnline = () => {
      setOnline(true);
      void (async () => {
        const { ok, failed, conflicts } = await replayOfflineMutations();
        refreshPending();
        if (ok > 0) toast.success(`${ok} perubahan offline disinkronkan`);
        if (failed > 0) toast.error(`${failed} perubahan gagal disinkron — coba lagi`);
        for (const c of conflicts) showConflictToast(c);
      })();
    };
    const handleOffline = () => setOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const onQueued = () => refreshPending();
    const onScopeChange = () => refreshPending();
    const onConflict = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; label?: string; error: string }>).detail;
      if (detail) showConflictToast(detail);
    };

    window.addEventListener('erp-offline-queued', onQueued);
    window.addEventListener('erp-scope-change', onScopeChange);
    window.addEventListener('erp-offline-conflict', onConflict);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('erp-offline-queued', onQueued);
      window.removeEventListener('erp-scope-change', onScopeChange);
      window.removeEventListener('erp-offline-conflict', onConflict);
    };
  }, [refreshPending, showConflictToast]);

  const handleRetryAll = () => {
    void (async () => {
      const { ok, failed, conflicts } = await replayOfflineMutations();
      refreshPending();
      if (ok > 0) toast.success(`${ok} perubahan disinkronkan`);
      if (failed > 0) toast.error(`${failed} perubahan gagal`);
      for (const c of conflicts) showConflictToast(c);
    })();
  };

  const handleRetryOne = (id: string) => {
    void (async () => {
      setBusyId(id);
      const result = await replayOfflineMutation(id);
      setBusyId(null);
      refreshPending();
      if (result === 'ok') toast.success('Berhasil disinkronkan');
      else if (result === 'conflict') toast.error('Konflik — data mungkin sudah berubah');
      else if (result === 'failed') toast.error('Gagal sinkron');
    })();
  };

  const handleDiscard = (id: string) => {
    void discardOfflineMutation(id).then(() => {
      refreshPending();
      toast.message('Item antrian dibuang');
    });
  };

  if (online && pending === 0) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-50 no-print">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`w-full text-white text-center py-1.5 text-sm font-medium flex items-center justify-center gap-2 ${online ? 'bg-amber-600 hover:bg-amber-700' : 'bg-red-600 hover:bg-red-700'}`}
      >
        {online ? <CloudUpload className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
        {online
          ? `${pending} perubahan menunggu sinkron…`
          : 'Offline — perubahan akan disinkron saat kembali online'}
        {pending > 0 && (expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
      </button>

      {expanded && pending > 0 && (
        <div className="bg-amber-50 border-b border-amber-200 text-amber-950 shadow-md max-h-64 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-amber-200 text-xs font-medium">
            <span>Antrian offline ({pending})</span>
            {online && (
              <button
                type="button"
                onClick={handleRetryAll}
                className="inline-flex items-center gap-1 text-amber-800 hover:text-amber-950"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Sinkron semua
              </button>
            )}
          </div>
          <ul className="divide-y divide-amber-100">
            {items.map((row) => (
              <li key={row.id} className="px-3 py-2 text-xs flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{formatLabel(row)}</p>
                  {row.lastError && (
                    <p className="text-red-700 mt-0.5 line-clamp-2">{row.lastError}</p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  {online && (
                    <button
                      type="button"
                      disabled={busyId === row.id}
                      onClick={() => handleRetryOne(row.id)}
                      className="p-1 rounded hover:bg-amber-100 disabled:opacity-50"
                      title="Coba lagi"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleDiscard(row.id)}
                    className="p-1 rounded hover:bg-amber-100 text-red-700"
                    title="Buang"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
