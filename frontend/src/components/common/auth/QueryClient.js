"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider, setLogger } from "react-query";
import { App } from "antd";
import NavigationProgress from "@/components/common/NavigationProgress";

// Every handled failure (401 on a wrong login, 403 for non-owner accounts,
// backend health probes) already surfaces through UI messages. react-query's
// dev logger also console.errors them, which pollutes the Next.js dev
// overlay, so route its output to the console without error level.
setLogger({
  log: console.log,
  warn: console.warn,
  error: (...args) => console.log("[react-query]", ...args),
});

const QueryClientContext = ({ children }) => {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchIntervalInBackground: false,
            refetchOnWindowFocus: false,
            cacheTime: 0,
            retry: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <App component={false}>
        <NavigationProgress />
        {children}
      </App>
    </QueryClientProvider>
  );
};

export default QueryClientContext;
