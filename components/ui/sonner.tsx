'use client';

import { useSyncExternalStore } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

function subscribeNoop() {
  return () => {};
}

const Toaster = ({ theme = 'light', ...props }: ToasterProps) => {
  const mounted = useSyncExternalStore(subscribeNoop, () => true, () => false);

  if (!mounted) return null;

  return (
    <Sonner
      theme={theme}
      className="toaster group"
      toastOptions={{
        classNames: {
          toast:
            'group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton:
            'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton:
            'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
