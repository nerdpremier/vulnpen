"use client";

import { useMemo } from "react";
import { useQuery } from "react-query";
import { getScanDetail } from "@/services/websecurity.service";
import { buildToolIndex } from "@/utils/toolIndex.mjs";
import { scanKey } from "@/utils/scanQueryKeys.mjs";
import { isScanLive } from "@/utils/scans.mjs";

/**
 * One scan's detail: its record, its joined results and the transcript slice
 * of its agent run. While the scan is queued or running the query polls every
 * 2s — a scan runs detached on the server (no SSE client), so the record and
 * the transcript the agent persists are the feed. Finished scans fetch once
 * and replay the same slice.
 */
export default function useScanActivity(sessionId, runId, { enabled = true } = {}) {
  const query = useQuery(
    scanKey(sessionId, runId),
    () => getScanDetail(sessionId, runId),
    {
      enabled: enabled && !!sessionId && !!runId,
      // What "live" means is the scan predicate's job, not this hook's.
      refetchInterval: (data) => (isScanLive(data?.run) ? 2000 : false),
      refetchIntervalInBackground: true,
    },
  );

  const detail = query.data ?? null;

  const { toolIndex, visibleMessages } = useMemo(
    () => buildToolIndex(detail?.messages ?? []),
    [detail],
  );

  const live = isScanLive(detail?.run);

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
