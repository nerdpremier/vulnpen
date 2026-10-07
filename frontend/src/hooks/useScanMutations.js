"use client";

import { useMutation, useQueryClient } from "react-query";
import { App } from "antd";
import { deleteScan, launchScan, stopScan } from "@/services/websecurity.service";
import { apiErrorMessage } from "@/utils/apiError";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { scansKey, scanKey, testPlanKey } from "@/utils/scanQueryKeys.mjs";

/**
 * What a scan mutation does to the caches, decided once.
 *
 * A scan writes case statuses onto the plan and findings onto the session, so
 * after any launch, stop or delete the list AND the plan go stale. A deleted
 * scan's detail cache is removed outright: its poll has stopped, so a
 * Browser-Back would otherwise re-render a record that no longer exists. A
 * launch also marks the chat's history stale — the scan writes its own
 * transcript channel, and the chat page reloads the store the next time it
 * opens.
 */
export function invalidateScanCaches(
  queryClient,
  sessionId,
  { removedRunId } = {},
) {
  if (removedRunId) queryClient.removeQueries(scanKey(sessionId, removedRunId));
  // The prefix invalidates every run's detail poll of this session, whatever
  // page is polling it.
  queryClient.invalidateQueries(["scan", sessionId]);
  queryClient.invalidateQueries(scansKey(sessionId));
  queryClient.invalidateQueries(testPlanKey(sessionId));
}

/**
 * The scan mutations — launch, stop, delete — with their cache coherence and
 * their toasts. Pages keep only the confirm dialogs and where to navigate.
 *
 * `launch.mutate({ testIds, label, policy, sourceRunId?, onLaunched? })` sends
 * everything but `onLaunched` to the API; the callback fires with the new run
 * when the launch is accepted, so a caller can navigate to the run's page.
 * The message names a retest a re-run (`sourceRunId` present) so the wording
 * follows what was actually launched.
 */
export default function useScanMutations(sessionId) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const stop = useMutation((runId) => stopScan(sessionId, runId), {
    onSuccess: () => {
      message.success("Stopping the scan");
      invalidateScanCaches(queryClient, sessionId);
    },
    onError: (error) =>
      message.error(apiErrorMessage(error, "Could not stop the scan")),
  });

  const remove = useMutation((runId) => deleteScan(sessionId, runId), {
    onSuccess: (_data, runId) => {
      message.success("Scan deleted");
      invalidateScanCaches(queryClient, sessionId, { removedRunId: runId });
    },
    onError: (error) =>
      message.error(apiErrorMessage(error, "Could not delete the scan")),
  });

  const launch = useMutation(
    ({ onLaunched, ...payload }) => launchScan({ sessionId, ...payload }),
    {
      onSuccess: (data, { onLaunched, sourceRunId }) => {
        const noun = sourceRunId ? "Re-run" : "Scan";
        message.success(
          data.position > 1
            ? `${noun} queued — position ${data.position}`
            : `${noun} launched — its results land on the scan page`,
        );
        invalidateScanCaches(queryClient, sessionId);
        useAgentStreamStore.getState().markHistoryStale?.(sessionId);
        onLaunched?.(data.run);
      },
      onError: (error) =>
        message.error(apiErrorMessage(error, "Could not launch the scan")),
    },
  );

  return { launch, stop, remove };
}
