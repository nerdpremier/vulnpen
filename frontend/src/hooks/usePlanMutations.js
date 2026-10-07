"use client";

import { useMutation, useQueryClient } from "react-query";
import { App } from "antd";
import { removeTestCase, removeTestCases, updateTestCase } from "@/services/websecurity.service";
import { apiErrorMessage } from "@/utils/apiError";
import { testPlanKey } from "@/utils/scanQueryKeys.mjs";

/**
 * The plan mutations — status update, case edit, remove one, remove many —
 * with their cache coherence and their toasts, mirroring useScanMutations for
 * the neighbouring resource. The page keeps only the confirm dialogs.
 *
 * The invalidation set is decided once: a plan write stales the plan AND the
 * session info (plan setup writes the engagement boundary, so the cached
 * values the modal starts from must refresh alongside the plan).
 */
export function invalidatePlanCaches(queryClient, sessionId) {
  queryClient.invalidateQueries(testPlanKey(sessionId));
  queryClient.invalidateQueries(["session-info", sessionId]);
}

/**
 * `onCaseRemoved(testId)` lets the page drop the removed id from its
 * selection so the selection bar can never reference a case the plan lost;
 * `onCasesRemoved()` fires after a bulk removal (the page clears the whole
 * selection).
 */
export function usePlanMutations(
  sessionId,
  { onCaseUpdated, onCaseRemoved, onCasesRemoved } = {},
) {
  const queryClient = useQueryClient();
  const { message } = App.useApp();

  const invalidate = () => invalidatePlanCaches(queryClient, sessionId);

  const statusMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} -> ${data.testCase?.status}`);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not save the result")),
  });

  const updateCaseMutation = useMutation(updateTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testCase?.testId} updated`);
      onCaseUpdated?.();
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not update the case")),
  });

  const removeCaseMutation = useMutation(removeTestCase, {
    onSuccess: (data) => {
      message.success(`${data.testId} removed from the plan`);
      onCaseRemoved?.(data.testId);
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not remove the case")),
  });

  const casesRemoveMutation = useMutation(removeTestCases, {
    onSuccess: (data) => {
      const removed = data?.removed?.length ?? 0;
      message.success(`${removed} case${removed === 1 ? "" : "s"} removed from the plan`);
      onCasesRemoved?.();
      invalidate();
    },
    onError: (error) => message.error(apiErrorMessage(error, "Could not remove the cases")),
  });

  return { statusMutation, updateCaseMutation, removeCaseMutation, casesRemoveMutation, invalidate };
}
