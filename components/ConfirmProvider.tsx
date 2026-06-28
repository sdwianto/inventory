'use client';

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
  type ReactNode,
} from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AlertTriangle } from 'lucide-react';

type ConfirmVariant = 'destructive' | 'warning' | 'info';

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: ConfirmVariant;
}

type ConfirmFn = (arg: string | ConfirmOptions) => Promise<boolean>;

const ConfirmCtx = createContext<ConfirmFn | null>(null);

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
export const useConfirm = (): ConfirmFn => {
  const ctx = useContext(ConfirmCtx);
  if (!ctx) {
    return async (msg) => Promise.resolve(
      window.confirm(typeof msg === 'string' ? msg : (msg?.description || msg?.title || 'Lanjutkan?')),
    );
  }
  return ctx;
};

interface ConfirmProviderProps {
  children: ReactNode;
}

export default function ConfirmProvider({ children }: ConfirmProviderProps) {
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState<Required<ConfirmOptions>>({
    title: 'Konfirmasi',
    description: '',
    confirmText: 'Ya',
    cancelText: 'Batal',
    variant: 'destructive',
  });
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((arg) => {
    return new Promise((resolve) => {
      const next: Required<ConfirmOptions> = typeof arg === 'string'
        ? {
            title: 'Konfirmasi',
            description: arg,
            confirmText: 'Ya',
            cancelText: 'Batal',
            variant: 'destructive',
          }
        : {
            title: 'Konfirmasi',
            description: '',
            confirmText: 'Ya',
            cancelText: 'Batal',
            variant: 'destructive',
            ...arg,
          };
      setOpts(next);
      resolverRef.current = resolve;
      setOpen(true);
    });
  }, []);

  const handleClose = (result: boolean) => {
    setOpen(false);
    if (resolverRef.current) {
      resolverRef.current(result);
      resolverRef.current = null;
    }
  };

  const variantStyles: Record<ConfirmVariant, { btn: string; icon: string }> = {
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
              <AlertTriangle className="w-5 h-5" />
              {' '}
              {opts.title}
            </DialogTitle>
            {opts.description ? (
              <DialogDescription className="whitespace-pre-line pt-1">
                {opts.description}
              </DialogDescription>
            ) : null}
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
