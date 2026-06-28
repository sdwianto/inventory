'use client';

// Single client boundary for the whole app (avoids multiple root client islands).

import type { ReactNode } from 'react';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConfirmProvider from '@/components/ConfirmProvider';
import OfflineIndicator from '@/components/OfflineIndicator';
import DevPerformanceErrorFilter from '@/components/DevPerformanceErrorFilter';
import { Toaster } from '@/components/ui/sonner';
import ApiCredentials from '@/components/ApiCredentials';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
    },
  },
});

export function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ApiCredentials />
      <DevPerformanceErrorFilter />
      <OfflineIndicator />
      <ConfirmProvider>{children}</ConfirmProvider>
      <Toaster richColors position="top-right" theme="light" />
    </QueryClientProvider>
  );
}
