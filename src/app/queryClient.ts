/* TanStack Query client. IPC calls are not idempotent network requests, so we
 * disable retries by default and keep responses fresh briefly. */

import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: 5_000,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
