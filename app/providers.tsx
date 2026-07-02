'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConfirmProvider from '@/components/ConfirmProvider';
import OfflineIndicator from '@/components/OfflineIndicator';
import DevPerformanceErrorFilter from '@/components/DevPerformanceErrorFilter';
import { Toaster } from '@/components/ui/sonner';
import ApiCredentials from '@/components/ApiCredentials';
import { PersistQueryProvider } from '@/lib/query-persist';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <PersistQueryProvider client={queryClient}>
        <ApiCredentials />
        <DevPerformanceErrorFilter />
        <OfflineIndicator />
        <ConfirmProvider>{children}</ConfirmProvider>
        <Toaster richColors position="top-right" theme="light" />
      </PersistQueryProvider>
    </QueryClientProvider>
  );
}
