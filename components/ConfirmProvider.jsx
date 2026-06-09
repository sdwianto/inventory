'use client';
import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

const ConfirmCtx = createContext(null);

/**
 * useConfirm — returns an async confirm() function.
 *
 * Usage:
 *   const confirm = useConfirm();
 *   if (!await confirm('Hapus item?')) return;
 *
 * Or with options:
 *   if (!await confirm({ title: 'Tutup Buku?', description: '...', confirmText: 'Lanjut', variant: 'warning' })) return;
 */
export const useConfirm = () => {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) {
    // Fallback to window.confirm if provider missing (shouldn't happen in normal flow)
    return async (msg) => Promise.resolve(window.confirm(typeof msg === 'string' ? msg : (msg?.description || msg?.title || 'Lanjutkan?')));
  }
  return ctx;
};

export default function ConfirmProvider({ children }) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState({ title: 'Konfirmasi', description: '', confirmText: 'Ya', cancelText: 'Batal', variant: 'destructive' });
  const resolverRef = useRef(null);

  const confirm = useCallback((arg) => {
    return new Promise((resolve) => {
      const next = typeof arg === 'string'
        ? { title: 'Konfirmasi', description: arg, confirmText: 'Ya', cancelText: 'Batal', variant: 'destructive' }
        : { title: 'Konfirmasi', description: '', confirmText: 'Ya', cancelText: 'Batal', variant: 'destructive', ...arg };
      setOpts(next);
      resolverRef.current = resolve;
      setOpen(true);
    });
  }, []);

  const handleClose = (result) => {
    setOpen(false);
    if (resolverRef.current) {
      resolverRef.current(result);
      resolverRef.current = null;
    }
  };

  const variantStyles = {
    destructive: { btn: 'bg-red-600 hover:bg-red-700', icon: 'text-red-600' },
    warning: { btn: 'bg-amber-500 hover:bg-amber-600', icon: 'text-amber-600' },
    info: { btn: 'bg-orange-500 hover:bg-orange-600', icon: 'text-orange-600' },
  };
  const style = variantStyles[opts.variant] || variantStyles.destructive;

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className={`flex items-center gap-2 ${style.icon}`}>
              <AlertTriangle className="w-5 h-5" /> {opts.title}
            </DialogTitle>
            {opts.description && (
              <DialogDescription className="whitespace-pre-line pt-1">
                {opts.description}
              </DialogDescription>
            )}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => handleClose(false)}>{opts.cancelText}</Button>
            <Button onClick={() => handleClose(true)} className={style.btn}>{opts.confirmText}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmCtx.Provider>
  );
}
