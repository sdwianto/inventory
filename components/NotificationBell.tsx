'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, Send } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatDateTime } from '@/lib/format';

const POLL_MS = 60_000;

type NotificationItem = {
  id: string;
  title: string;
  body: string;
  link: string | null;
  severity: 'info' | 'warning' | 'critical';
  readAt: string | null;
  createdAt: string;
};

type TelegramStatus = {
  enabled: boolean;
  linked: boolean;
  telegramUsername: string | null;
};

const SEVERITY_DOT: Record<NotificationItem['severity'], string> = {
  info: 'bg-sky-500',
  warning: 'bg-amber-500',
  critical: 'bg-red-600',
};

async function postJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(String(data.error || 'Permintaan gagal'));
  return data;
}

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus | null>(null);
  const [telegramBusy, setTelegramBusy] = useState(false);

  const loadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/unread-count');
      if (!res.ok) return;
      const data = await res.json();
      setUnread(Number(data.unread || 0));
    } catch {
      /* jaringan putus — coba lagi di polling berikutnya */
    }
  }, []);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, tgRes] = await Promise.all([
        fetch('/api/notifications?limit=20'),
        fetch('/api/notifications/telegram'),
      ]);
      if (listRes.ok) {
        const data = await listRes.json();
        setItems((data.items || []) as NotificationItem[]);
        setUnread(Number(data.unread || 0));
      }
      if (tgRes.ok) setTelegram(await tgRes.json() as TelegramStatus);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void loadCount());
    const tick = () => {
      if (document.visibilityState === 'visible') void loadCount();
    };
    const t = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [loadCount]);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) void loadList();
  };

  const openItem = async (item: NotificationItem) => {
    if (!item.readAt) {
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnread((u) => Math.max(0, u - 1));
      void postJson(`/api/notifications/${item.id}/read`).catch(() => undefined);
    }
    if (item.link) {
      setOpen(false);
      router.push(item.link);
    }
  };

  const markAll = async () => {
    try {
      await postJson('/api/notifications/read-all');
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt || new Date().toISOString() })));
      setUnread(0);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    }
  };

  const linkTelegram = async () => {
    // Jendela dibuka sinkron di dalam klik — setelah await, browser memblokirnya sebagai popup.
    const win = window.open('about:blank', '_blank');
    if (win) win.opener = null;
    setTelegramBusy(true);
    try {
      const data = await postJson('/api/notifications/telegram/link');
      const deepLink = String(data.deepLink);
      if (win) win.location.href = deepLink;
      else window.location.assign(deepLink);
      toast.info('Tekan "Start" di Telegram untuk menyelesaikan penautan (berlaku 15 menit)');
    } catch (e) {
      win?.close();
      toast.error(e instanceof Error ? e.message : 'Gagal membuat tautan');
    } finally {
      setTelegramBusy(false);
    }
  };

  const unlinkTelegram = async () => {
    setTelegramBusy(true);
    try {
      await postJson('/api/notifications/telegram/unlink');
      setTelegram((t) => (t ? { ...t, linked: false, telegramUsername: null } : t));
      toast.success('Telegram diputus');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Gagal');
    } finally {
      setTelegramBusy(false);
    }
  };

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative shrink-0" aria-label="Notifikasi">
          <Bell className="w-5 h-5 text-slate-600" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-bold leading-[18px] text-center">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[min(92vw,24rem)] p-0">
        <div className="flex items-center justify-between px-3 py-2 border-b">
          <span className="text-sm font-semibold">Notifikasi</span>
          {unread > 0 && (
            <button type="button" className="text-xs text-orange-700 hover:underline flex items-center gap-1" onClick={markAll}>
              <CheckCheck className="w-3.5 h-3.5" /> Tandai semua dibaca
            </button>
          )}
        </div>
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
          {loading && !items.length && <p className="px-3 py-6 text-center text-xs text-slate-400">Memuat…</p>}
          {!loading && !items.length && (
            <p className="px-3 py-6 text-center text-xs text-slate-400">Belum ada notifikasi</p>
          )}
          {items.map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() => void openItem(n)}
              className={`w-full text-left px-3 py-2 border-b last:border-0 hover:bg-slate-50 ${n.readAt ? '' : 'bg-orange-50/40'}`}
            >
              <div className="flex items-start gap-2">
                <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.readAt ? 'bg-slate-200' : SEVERITY_DOT[n.severity]}`} />
                <div className="min-w-0">
                  <p className={`text-xs ${n.readAt ? 'text-slate-600' : 'font-semibold text-slate-800'}`}>{n.title}</p>
                  <p className="text-[11px] text-slate-500 whitespace-pre-line line-clamp-4 mt-0.5">{n.body}</p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{formatDateTime(n.createdAt)}</p>
                </div>
              </div>
            </button>
          ))}
        </div>
        {telegram?.enabled && (
          <div className="border-t px-3 py-2 flex items-center justify-between gap-2 text-xs">
            {telegram.linked ? (
              <>
                <span className="text-slate-600">
                  Telegram terhubung{telegram.telegramUsername ? ` (@${telegram.telegramUsername})` : ''}
                </span>
                <button
                  type="button"
                  className="text-red-600 hover:underline disabled:opacity-50"
                  disabled={telegramBusy}
                  onClick={() => void unlinkTelegram()}
                >
                  Putuskan
                </button>
              </>
            ) : (
              <>
                <span className="text-slate-500">Terima notifikasi di Telegram</span>
                <Button size="sm" variant="outline" className="h-7 text-xs" disabled={telegramBusy} onClick={() => void linkTelegram()}>
                  <Send className="w-3 h-3 mr-1" /> Tautkan
                </Button>
              </>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
