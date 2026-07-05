'use client';

import type { ReactNode } from 'react';
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import ConfirmProvider from '@/components/ConfirmProvider';
import OfflineIndicator from '@/components/OfflineIndicator';
import DevPerformanceErrorFilter from '@/components/DevPerformanceErrorFilter';
import { Toaster } from '@/components/ui/sonner';
import ApiCredentials from '@/components/ApiCredentials';
import SentryInit from '@/components/SentryInit';
import ClientAppLayout from '@/components/ClientAppLayout';
import { PersistQueryProvider } from '@/lib/query-persist';

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 60_000,
        gcTime: 600_000,
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
        <SentryInit />
        <DevPerformanceErrorFilter />
        <OfflineIndicator />
        <ConfirmProvider>
          <ClientAppLayout>{children}</ClientAppLayout>
        </ConfirmProvider>
        <Toaster richColors position="top-right" theme="light" />
      </PersistQueryProvider>
    </QueryClientProvider>
  );
}
