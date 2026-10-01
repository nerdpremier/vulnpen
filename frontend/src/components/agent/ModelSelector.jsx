import { App, Dropdown } from "antd";
import { FiCpu } from "react-icons/fi";
import { TbBrain } from "react-icons/tb";
import { RiArrowDownSLine, RiCheckLine } from "react-icons/ri";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getSwarmModels, updateSwarmModels } from "@/services/user.service";
import styles from "@/styles/components/Chat.module.scss";

const REASONING_LEVELS = ["off", "low", "medium", "high"];

const useModelRegistry = () =>
  useQuery(["swarm-models"], getSwarmModels, { staleTime: 30000 });

const useUpdateRegistry = () => {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  return useMutation(updateSwarmModels, {
    onSuccess: () => queryClient.invalidateQueries(["swarm-models"]),
    onError: () => message.error("Failed to update model settings"),
  });
};

/**
 * Quick model picker for the composer: shows the orchestrator model and lets
 * the user switch between the models registered in Settings.
 */
export function ModelSelector() {
  const { data } = useModelRegistry();
  const updateRegistry = useUpdateRegistry();

  const models = data?.models ?? [];
  const assignments = data?.assignments ?? {};
  const current =
    models.find((model) => model.id === assignments.orchestratorModelId) ??
    models[0];

  if (models.length === 0 || !current) return null;

  const menu = {
    items: models.map((model) => ({
      key: model.id,
      label: model.label,
      icon: model.id === current.id ? <RiCheckLine /> : null,
    })),
    onClick: ({ key }) =>
      updateRegistry.mutate({
        models,
        assignments: { ...assignments, orchestratorModelId: key },
      }),
  };

  return (
    <Dropdown
      trigger={["click"]}
      placement="topLeft"
      overlayClassName="modelDropdown"
      menu={menu}
    >
      <button
        type="button"
        className={styles.modeSelector}
        aria-label="Agent model"
        disabled={updateRegistry.isLoading}
      >
        <FiCpu size={14} className={styles.modeSelectorIcon} />
        <span className={styles.modeSelectorLabel}>{current.label}</span>
        <RiArrowDownSLine size={14} className={styles.modeSelectorChevron} />
      </button>
    </Dropdown>
  );
}

/**
 * Model picker for the Browser Agent panel: assigns which registered model
 * drives browser_action (the same registry as the composer's selector).
 */
export function BrowserModelSelector() {
  const { data } = useModelRegistry();
  const updateRegistry = useUpdateRegistry();

  const models = data?.models ?? [];
  const assignments = data?.assignments ?? {};
  const current = models.find((model) => model.id === assignments.browserModelId);

  if (models.length === 0) return null;

  const menu = {
    items: models.map((model) => ({
      key: model.id,
      label: model.label,
      icon: model.id === current?.id ? <RiCheckLine /> : null,
    })),
    onClick: ({ key }) =>
      updateRegistry.mutate({
        models,
        assignments: { ...assignments, browserModelId: key },
      }),
  };

  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="modelDropdown"
      menu={menu}
    >
      <button
        type="button"
        className={styles.modeSelector}
        aria-label="Browser agent model"
        disabled={updateRegistry.isLoading}
      >
        <FiCpu size={14} className={styles.modeSelectorIcon} />
        <span className={styles.modeSelectorLabel}>
          {current?.label ?? "Select model"}
        </span>
        <RiArrowDownSLine size={14} className={styles.modeSelectorChevron} />
      </button>
    </Dropdown>
  );
}

/**
 * Reasoning-effort picker for the Browser Agent panel: edits the
 * reasoningMode of the currently assigned browser model (not the orchestrator's).
 */
export function BrowserReasoningSelector() {
  const { data } = useModelRegistry();
  const updateRegistry = useUpdateRegistry();

  const models = data?.models ?? [];
  const assignments = data?.assignments ?? {};
  const current = models.find((model) => model.id === assignments.browserModelId);

  if (models.length === 0 || !current) return null;

  const level = REASONING_LEVELS.includes(current.reasoningMode)
    ? current.reasoningMode
    : "off";

  const menu = {
    items: REASONING_LEVELS.map((value) => ({
      key: value,
      label: value.charAt(0).toUpperCase() + value.slice(1),
      icon: value === level ? <RiCheckLine /> : null,
    })),
    onClick: ({ key }) =>
      updateRegistry.mutate({
        models: models.map((model) =>
          model.id === current.id ? { ...model, reasoningMode: key } : model,
        ),
        assignments,
      }),
  };

  return (
    <Dropdown
      trigger={["click"]}
      placement="bottomRight"
      overlayClassName="modelDropdown"
      menu={menu}
    >
      <button
        type="button"
        className={styles.modeSelector}
        aria-label="Browser agent reasoning effort"
        disabled={updateRegistry.isLoading}
      >
        <TbBrain size={14} className={styles.modeSelectorIcon} />
        <span className={styles.modeSelectorLabel}>
          {level.charAt(0).toUpperCase() + level.slice(1)}
        </span>
        <RiArrowDownSLine size={14} className={styles.modeSelectorChevron} />
      </button>
    </Dropdown>
  );
}

/**
 * Reasoning-effort picker for the composer: edits the reasoningMode of the
 * current orchestrator model (off / low / medium / high).
 */
export function ReasoningSelector() {
  const { data } = useModelRegistry();
  const updateRegistry = useUpdateRegistry();

  const models = data?.models ?? [];
  const assignments = data?.assignments ?? {};
  const current =
    models.find((model) => model.id === assignments.orchestratorModelId) ??
    models[0];

  if (models.length === 0 || !current) return null;

  const level = REASONING_LEVELS.includes(current.reasoningMode)
    ? current.reasoningMode
    : "off";

  const menu = {
    items: REASONING_LEVELS.map((value) => ({
      key: value,
      label: value.charAt(0).toUpperCase() + value.slice(1),
      icon: value === level ? <RiCheckLine /> : null,
    })),
    onClick: ({ key }) =>
      updateRegistry.mutate({
        models: models.map((model) =>
          model.id === current.id ? { ...model, reasoningMode: key } : model,
        ),
        assignments,
      }),
  };

  return (
    <Dropdown
      trigger={["click"]}
      placement="topLeft"
      overlayClassName="modelDropdown"
      menu={menu}
    >
      <button
        type="button"
        className={styles.modeSelector}
        aria-label="Reasoning effort"
        disabled={updateRegistry.isLoading}
      >
        <TbBrain size={14} className={styles.modeSelectorIcon} />
        <span className={styles.modeSelectorLabel}>
          {level.charAt(0).toUpperCase() + level.slice(1)}
        </span>
        <RiArrowDownSLine size={14} className={styles.modeSelectorChevron} />
      </button>
    </Dropdown>
  );
}
