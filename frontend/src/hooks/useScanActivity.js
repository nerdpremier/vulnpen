"use client";

import { useMemo } from "react";
import { useQuery } from "react-query";
import { getScanDetail } from "@/services/websecurity.service";
import { buildToolIndex } from "@/utils/toolIndex.mjs";

/**
 * One scan's detail: its record, its joined results and the transcript slice
 * of its agent run. While the scan is queued or running the query polls every
 * 2s — a scan runs detached on the server (no SSE client), so the record and
 * the transcript the agent persists are the feed. Finished scans fetch once
 * and replay the same slice.
 */
export default function useScanActivity(sessionId, runId, { enabled = true } = {}) {
  const query = useQuery(
    ["scan", sessionId, runId],
    () => getScanDetail(sessionId, runId),
    {
      enabled: enabled && !!sessionId && !!runId,
      refetchInterval: (data) => {
        const status = data?.run?.status;
        return status === "queued" || status === "running" ? 2000 : false;
      },
      refetchIntervalInBackground: true,
    },
  );

  const detail = query.data ?? null;

  const { toolIndex, visibleMessages } = useMemo(
    () => buildToolIndex(detail?.messages ?? []),
    [detail],
  );

  const status = detail?.run?.status ?? null;
  const live = status === "queued" || status === "running";

  return {
    run: detail?.run ?? null,
    cases: detail?.cases ?? [],
    findings: detail?.findings ?? [],
    visibleMessages,
    toolIndex,
    pendingConsent: live ? detail?.pendingConsent ?? null : null,
    agentState: detail?.agentState ?? null,
    live,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
