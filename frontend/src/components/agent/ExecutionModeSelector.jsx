import { App, Dropdown, Tooltip } from "antd";
import { FiZap, FiCheckCircle, FiAlertOctagon } from "react-icons/fi";
import { MdOutlineFrontHand } from "react-icons/md";
import { RiArrowDownSLine, RiCheckLine } from "react-icons/ri";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getCapabilities, updateCapabilities } from "@/services/user.service";
import styles from "@/styles/components/Chat.module.scss";

/** Tool execution modes, in the order they appear in the menu. */
const EXECUTION_MODES = [
  {
    value: "auto",
    label: "Auto run",
    description: "Run automatically; destructive actions still ask.",
    icon: FiZap,
  },
  {
    value: "auto_approve",
    label: "Approve for me",
    description: "A reviewer approves boundary-crossing actions.",
    icon: FiCheckCircle,
  },
  {
    value: "requires_consent",
    label: "Requires consent",
    description: "Ask before every tool action.",
    icon: MdOutlineFrontHand,
  },
];

const MODE_FALLBACK = EXECUTION_MODES[0];

/**
 * Tool execution mode picker, shown next to the chat composer so the mode is
 * always visible and one click away (ChatGPT/Claude style). The button shows
 * the current mode's icon + label; the menu lists each mode with its own icon
 * and a one-line description, check-marking the active one.
 */
const ExecutionModeSelector = () => {
  const { message } = App.useApp();
  const queryClient = useQueryClient();

  const { data: capabilitiesData } = useQuery("capabilities", getCapabilities);
  const toolExecutionMode = capabilitiesData?.toolExecutionMode ?? "auto";

  const updateCapabilitiesMutation = useMutation(updateCapabilities, {
    onSuccess: () => {
      queryClient.invalidateQueries("capabilities");
    },
    onError: () => {
      message.error("Failed to update tool execution mode");
    },
  });

  const currentMode =
    EXECUTION_MODES.find((mode) => mode.value === toolExecutionMode) ??
    MODE_FALLBACK;
  const CurrentIcon = currentMode.icon;

  return (
    <Dropdown
      trigger={["click"]}
      placement="topLeft"
      overlayClassName="modeDropdown"
      menu={{
        items: EXECUTION_MODES.map((mode) => {
          const Icon = mode.icon;
          const selected = mode.value === toolExecutionMode;
          return {
            key: mode.value,
            label: (
              <span className={styles.modeItem}>
                <span className={styles.modeItemMain}>
                  <span className={styles.modeItemTitle}>
                    <Icon className={styles.modeItemIcon} />
                    {mode.label}
                  </span>
                  <span className={styles.modeItemDesc}>{mode.description}</span>
                </span>
                {selected && (
                  <RiCheckLine className={styles.modeItemCheck} size={15} />
                )}
              </span>
            ),
          };
        }),
        onClick: ({ key }) =>
          updateCapabilitiesMutation.mutate({ toolExecutionMode: key }),
      }}
    >
      <button
        type="button"
        className={styles.modeSelector}
        aria-label="Tool execution mode"
        disabled={updateCapabilitiesMutation.isLoading}
      >
        <CurrentIcon size={14} className={styles.modeSelectorIcon} />
        <span className={styles.modeSelectorLabel}>{currentMode.label}</span>
        <RiArrowDownSLine size={14} className={styles.modeSelectorChevron} />
      </button>
    </Dropdown>
  );
};

export default ExecutionModeSelector;
