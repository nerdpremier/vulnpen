import { App, Dropdown, Tooltip } from "antd";
import styles from "@/styles/pages/Session.module.scss";
import Image from "next/image";
import quad from "@/assets/sidebar/quad.svg";
import rect from "@/assets/sidebar/rect.svg";
import { useDispatch, useSelector } from "react-redux";
import { setRecon, updateCurrentSession, updateSessions } from "@/store/user.slice";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getCapabilities, updateCapabilities } from "@/services/user.service";
import { clearContext, getVulnerabilities } from "@/services/agent.service";
import { getTestPlan } from "@/services/websecurity.service";
import AgentToolsPanel from "@/components/session/AgentToolsPanel";
import { FiCheckSquare, FiMonitor, FiShield } from "react-icons/fi";
import { MdOutlineDeleteSweep } from "react-icons/md";
import { HiOutlineChevronLeft } from "react-icons/hi";
import { RiArrowDownSLine, RiCheckLine } from "react-icons/ri";
import { useAgentStreamStore } from "@/store/agentStream.store";
import ContextUsageIndicator from "@/components/agent/ContextUsageIndicator";

/**
 * Session rail.
 *
 * Three stacked zones: who/where you are at the top, the grouped view
 * navigation in the middle (Workspace / Testing / Views), and the session
 * utilities pinned to the bottom. The rail collapses to icons below 768px so
 * the workspace keeps its width on a laptop.
 */
/** Tool execution modes, in the order they appear in the menu. */
const EXECUTION_MODES = [
  { value: "auto", label: "Auto run" },
  { value: "auto_approve", label: "Approve for me" },
  { value: "requires_consent", label: "Requires consent" },
];

const Sidebar = ({ sessionId, workspaceId }) => {
  const router = useRouter();
  const pathname = usePathname();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const { modal, message } = App.useApp();

  const { data: capabilitiesData } = useQuery("capabilities", getCapabilities);
  const { data: vulnerabilitiesData } = useQuery(
    ["vulnerabilities", sessionId],
    () => getVulnerabilities(sessionId),
    { enabled: !!sessionId, refetchInterval: 5000, retry: false },
  );
  const { data: testPlanData } = useQuery(
    ["test-plan", sessionId],
    () => getTestPlan(sessionId),
    { enabled: !!sessionId, refetchInterval: 15000, retry: false },
  );
  const testPlanCoverage = testPlanData?.coverage;
  const toolExecutionMode = capabilitiesData?.toolExecutionMode ?? "auto";

  const updateCapabilitiesMutation = useMutation(updateCapabilities, {
    onSuccess: () => {
      queryClient.invalidateQueries("capabilities");
    },
    onError: () => {
      message.error("Failed to update tool execution mode");
    },
  });

  const handleExecutionModeChange = (mode) => {
    updateCapabilitiesMutation.mutate({
      toolExecutionMode: mode,
    });
  };

  const { sessions } = useSelector((state) => state.user);
  const orchestratorTokenUsage = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.tokenUsage ?? null,
  );

  const handleClickTab = (id) => {
    dispatch(updateCurrentSession(id));
    const selectedSession = sessions.filter((s) => s.id === id);
    if (selectedSession.length > 0) {
      router.push(`/session/${id}`);
    }
  };

  const navigateToGUI = () => {
    const guiId = `${sessionId}/gui`;
    let updatedSess = [...sessions];
    const exists = updatedSess.find((s) => s.id === guiId);
    if (!exists) {
      updatedSess = updatedSess.map((s) => ({ ...s, is_active: false }));
      updatedSess.push({ id: guiId, is_main: false, is_active: true, type: "gui" });
      dispatch(updateSessions(updatedSess));
    }
    router.push(`/session/${sessionId}/gui`);
  };

  const exitTarget = workspaceId
    ? `/workspace/${workspaceId}`
    : "/dashboard";

  const isOnWorkspace = pathname === `/session/${sessionId}`;
  const isOnGUI = pathname?.includes("/gui");
  const isOnVulnerabilities = pathname?.includes("/vulnerabilities");
  const isOnTestPlan = pathname?.includes("/test-plan");
  const contextUsageForTab = orchestratorTokenUsage;

  const mainSessions = sessions.filter((s) => s.is_main && s.type === "session");
  const subSessions = sessions.filter((s) => !s.is_main && s.type === "session");

  const handleClearContext = () => {
    modal.confirm({
      title: "Clear context?",
      content:
        "This will erase all conversation history for this session. The system prompt and shells will be preserved.",
      okText: "Clear",
      okType: "danger",
      cancelText: "Cancel",
      centered: true,
      async onOk() {
        try {
          await clearContext({ sessionId });
          message.success("Context cleared");
          window.dispatchEvent(
            new CustomEvent("context-cleared", { detail: { sessionId } }),
          );
          queryClient.invalidateQueries(["session-info", sessionId]);
        } catch {
          message.error("Failed to clear context");
        }
      },
    });
  };

  const executionModeLabel =
    EXECUTION_MODES.find((mode) => mode.value === toolExecutionMode)?.label ??
    "Auto run";

  const executionModeHint =
    toolExecutionMode === "auto"
      ? "Run automatically; built-in destructive-action protections still ask."
      : toolExecutionMode === "auto_approve"
        ? "A separate reviewer handles actions that cross an approval boundary. This does not replace host isolation."
        : "Ask before every tool action.";

  return (
    <aside className={styles.sidebar} aria-label="Session navigation">
      <div className={styles.sidebarTop}>
        <div className={styles.navRow}>
          <Tooltip title="All workspaces" placement="right">
            <button
              type="button"
              className={styles.navBtn}
              aria-label="Back to all workspaces"
              onClick={() => {
                dispatch(setRecon(false));
                router.push("/dashboard");
              }}
            >
              <HiOutlineChevronLeft size={13} />
            </button>
          </Tooltip>
          <button
            type="button"
            className={styles.navLabel}
            onClick={() => {
              dispatch(setRecon(false));
              router.push(exitTarget);
            }}
          >
            {workspaceId ? "Workspace" : "Dashboard"}
          </button>
        </div>

        <Tooltip placement="right" title={executionModeHint}>
          <Dropdown
            trigger={["click"]}
            placement="bottomLeft"
            menu={{
              items: EXECUTION_MODES.map((mode) => ({
                key: mode.value,
                icon:
                  mode.value === toolExecutionMode ? (
                    <RiCheckLine />
                  ) : (
                    <span className={styles.modeMarker} />
                  ),
                label: mode.label,
              })),
              onClick: ({ key }) => handleExecutionModeChange(key),
            }}
          >
            <button
              type="button"
              className={styles.modeControl}
              aria-label="Tool execution mode"
              disabled={updateCapabilitiesMutation.isLoading}
            >
              <FiShield size={14} className={styles.modeIcon} />
              <span className={styles.modeLabel}>{executionModeLabel}</span>
              <RiArrowDownSLine className={styles.modeChevron} />
            </button>
          </Dropdown>
        </Tooltip>

        <AgentToolsPanel sessionId={sessionId} />
      </div>

      <nav className={styles.sidebarNav}>
        <div className={styles.navSectionLabel}>Workspace</div>

        {mainSessions.map((sess) => (
          <div
            key={sess.id}
            role="button"
            tabIndex={0}
            onClick={() => handleClickTab(sess.id)}
            onKeyDown={(event) => event.key === "Enter" && handleClickTab(sess.id)}
            className={sess?.is_active ? styles.activeTab : styles.tab}
          >
            <Image src={quad} width={14} height={14} alt="" />
            <span className={styles.navText}>Main workspace</span>
          </div>
        ))}

        {subSessions.map((sess, i) => (
          <div
            key={sess.id}
            role="button"
            tabIndex={0}
            onClick={() => handleClickTab(sess.id)}
            onKeyDown={(event) => event.key === "Enter" && handleClickTab(sess.id)}
            className={sess?.is_active ? styles.activeTab : styles.tab}
          >
            <Image src={rect} width={14} height={14} alt="" />
            <span className={styles.navText}>Sub workspace {i + 1}</span>
          </div>
        ))}

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}`)}
          onKeyDown={(event) =>
            event.key === "Enter" && router.push(`/session/${sessionId}`)
          }
          className={isOnWorkspace ? styles.activeTab : styles.tab}
        >
          <Image src={quad} width={14} height={14} alt="" />
          <span className={styles.navText}>Chat</span>
        </div>

        <div className={styles.navSectionLabel}>Testing</div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}/test-plan`)}
          onKeyDown={(event) =>
            event.key === "Enter" && router.push(`/session/${sessionId}/test-plan`)
          }
          className={isOnTestPlan ? styles.activeTab : styles.tab}
        >
          <FiCheckSquare />
          <span className={styles.navText}>Web Security Testing Guide</span>
          {testPlanCoverage?.total > 0 && (
            <span className={styles.navBadge}>
              {testPlanCoverage.executed}/{testPlanCoverage.total}
            </span>
          )}
        </div>

        <div
          role="button"
          tabIndex={0}
          onClick={() => router.push(`/session/${sessionId}/vulnerabilities`)}
          onKeyDown={(event) =>
            event.key === "Enter" &&
            router.push(`/session/${sessionId}/vulnerabilities`)
          }
          className={isOnVulnerabilities ? styles.activeTab : styles.tab}
        >
          <FiShield />
          <span className={styles.navText}>Vulnerabilities</span>
          {(vulnerabilitiesData?.total ?? 0) > 0 && (
            <span className={styles.navBadge}>{vulnerabilitiesData.total}</span>
          )}
        </div>

        <div className={styles.navSectionLabel}>Views</div>

        <div
          role="button"
          tabIndex={0}
          onClick={navigateToGUI}
          onKeyDown={(event) => event.key === "Enter" && navigateToGUI()}
          className={isOnGUI ? styles.activeTab : styles.tab}
        >
          <FiMonitor />
          <span className={styles.navText}>GUI</span>
        </div>
      </nav>

      <div className={styles.additionalOptions}>
        {contextUsageForTab && (
          <ContextUsageIndicator tokenUsage={contextUsageForTab} />
        )}
        <div className={styles.supportStep}>
          <button
            type="button"
            className={styles.options}
            onClick={handleClearContext}
          >
            <MdOutlineDeleteSweep size={15} />
            Clear context
          </button>
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
