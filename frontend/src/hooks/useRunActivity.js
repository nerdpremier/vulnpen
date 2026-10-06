"use client";

import { useMemo } from "react";
import { useQuery } from "react-query";
import { getTestRunDetail } from "@/services/websecurity.service";
import { buildToolIndex } from "@/utils/toolIndex.mjs";

/**
 * One run's detail: its record plus the transcript slice of that run. While
 * the run is queued or running the query polls every 2s — the backend run is
 * detached (no SSE client), so the transcript the agent persists is the feed.
 * Finished runs fetch once and replay the same slice.
 */
export default function useRunActivity(sessionId, runId, { enabled = true } = {}) {
  const query = useQuery(
    ["test-run", sessionId, runId],
    () => getTestRunDetail(sessionId, runId),
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
  const messages = detail?.messages ?? [];

  const { toolIndex, visibleMessages } = useMemo(
    () => buildToolIndex(messages),
    [messages],
  );

  const status = detail?.run?.status ?? null;
  const live = status === "queued" || status === "running";

  return {
    run: detail?.run ?? null,
    visibleMessages,
    toolIndex,
    pendingConsent: live ? detail?.pendingConsent ?? null : null,
    agentState: detail?.agentState ?? null,
    live,
    isLoading: query.isLoading,
  };
}
