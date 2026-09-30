"use client";

import { useMemo } from "react";
import { Alert } from "antd";
import { useQuery } from "react-query";
import { getModels } from "@/services/user.service";

function hasUsableOrchestrator(data) {
  const models = data?.models || [];
  const orchestratorId = data?.assignments?.orchestratorModelId;
  if (!models.length || !orchestratorId) return false;

  const orchestrator = models.find((model) => model.id === orchestratorId);
  return Boolean(orchestrator?.provider && orchestrator?.model && orchestrator?.verifiedAt);
}

// The models endpoint is host-owner only; a 403 is a normal state for other
// accounts, so return a marker instead of throwing (a throw would land in the
// Next.js dev overlay as a console error via react-query's dev logger).
async function loadModelsQuietly() {
  try {
    return await getModels();
  } catch (err) {
    if (err?.response?.status === 403) return { forbidden: true };
    throw err;
  }
}

/**
 * Non-blocking: lets the user in immediately and only surfaces a warning
 * banner while no usable orchestrator model is configured. Model setup
 * happens in Settings > Models whenever the user chooses.
 */
const ModelSetupGate = ({ children }) => {
  // cacheTime is 0 globally, so the query refetches on every navigation and
  // `data` is undefined mid-flight — the banner must wait for a settled
  // result or it flashes on every page change.
  const { data, isLoading } = useQuery("unified-models", loadModelsQuietly, {
    staleTime: 15 * 1000,
    retryOnMount: false,
    retry: false,
  });

  const isConfigured = useMemo(() => hasUsableOrchestrator(data), [data]);
  const forbidden = data?.forbidden === true;

  return (
    <>
      {!isConfigured && !isLoading && (
        <div style={{ padding: "0.5rem 1rem 0" }}>
          <Alert
            type="warning"
            showIcon
            message="No orchestrator model configured yet"
            description={
              forbidden
                ? "Model management is limited to the installation owner (the first registered account). Configure models from that account in Settings > Models."
                : "Set up a model in Settings > Models when you're ready; everything else works right now."
            }
            banner
          />
        </div>
      )}
      {children}
    </>
  );
};

export default ModelSetupGate;
