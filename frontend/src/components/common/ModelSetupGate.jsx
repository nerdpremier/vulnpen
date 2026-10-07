"use client";

import { useCallback, useMemo, useState } from "react";
import { useQuery } from "react-query";
import { FiAlertTriangle, FiInfo, FiX } from "react-icons/fi";
import { getModels } from "@/services/user.service";
import styles from "@/styles/components/ModelGate.module.scss";

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
 * Non-blocking: lets the user in immediately and only surfaces a banner while
 * the orchestrator model is missing, unexplained, or unreadable. Model setup
 * happens in Settings > Models whenever the user chooses.
 *
 * A response of "no data" and a *failed request* are different facts, so they
 * get different copy: claiming "no model is configured" because the API was
 * unreachable would send the operator to re-configure models they still have.
 */
const ModelSetupGate = ({ children }) => {
  // cacheTime is 0 globally, so the query refetches on every navigation and
  // `data` is undefined mid-flight — the banner must wait for a settled
  // result or it flashes on every page change.
  const { data, isLoading, isError, refetch } = useQuery(
    "unified-models",
    loadModelsQuietly,
    {
      staleTime: 15 * 1000,
      retryOnMount: false,
      retry: false,
    }
  );

  // Dismissal lives in component state: the layout outlives client-side
  // navigation, so it holds for the working session without reading storage
  // (a storage read would need an effect, and setting state in an effect costs
  // a second render pass on every page).
  const [dismissed, setDismissed] = useState(false);
  const dismiss = useCallback(() => setDismissed(true), []);

  const openModelSettings = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("open-settings", { detail: { tab: "models" } })
    );
  }, []);

  const isConfigured = useMemo(() => hasUsableOrchestrator(data), [data]);
  const forbidden = data?.forbidden === true;
  const show = !isConfigured && !isLoading && !dismissed;

  if (!show) return children;

  const ownerCanFix = !forbidden && !isError;
  const tone = ownerCanFix ? styles.warning : styles.info;
  const title = forbidden
    ? "Model configuration is managed by the installation owner"
    : isError
      ? "Could not check the model configuration"
      : "No orchestrator model configured yet";
  const body = forbidden
    ? "Only the first registered account can add or assign models. Everything else in VulnPen works for you right now."
    : isError
      ? "The models endpoint did not answer, so this screen cannot tell whether a model is set up. Nothing has been changed."
      : "Nothing is blocking you — but the agent has no model to think with. Pick one in Settings when you are ready.";

  return (
    <>
      <div className={`${styles.gate} ${tone}`} role="status">
        <span className={styles.icon} aria-hidden="true">
          {ownerCanFix ? <FiAlertTriangle /> : <FiInfo />}
        </span>
        <div className={styles.copy}>
          <p className={styles.title}>{title}</p>
          <p className={styles.body}>{body}</p>
        </div>
        <div className={styles.actions}>
          {ownerCanFix && (
            <button
              type="button"
              className={styles.primary}
              onClick={openModelSettings}
            >
              Open model settings
            </button>
          )}
          {isError && (
            <button
              type="button"
              className={styles.primary}
              onClick={() => refetch()}
            >
              Retry
            </button>
          )}
          <button
            type="button"
            className={styles.ghost}
            onClick={dismiss}
            aria-label="Dismiss this message"
            title="Dismiss until you reload"
          >
            <FiX size={13} />
          </button>
        </div>
      </div>
      {children}
    </>
  );
};

export default ModelSetupGate;
