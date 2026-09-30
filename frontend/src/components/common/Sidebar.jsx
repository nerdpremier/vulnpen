import { useMemo } from "react";
import { App, Tooltip } from "antd";
import styles from "@/styles/pages/Session.module.scss";
import Image from "next/image";
import quad from "@/assets/sidebar/quad.svg";

import rect from "@/assets/sidebar/rect.svg";
import { useDispatch, useSelector } from "react-redux";
import { setRecon, updateCurrentSession } from "@/store/user.slice";
import { useRouter, usePathname } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getCapabilities, updateCapabilities } from "@/services/user.service";
import { clearContext, getVulnerabilities } from "@/services/agent.service";
import { getTestPlan } from "@/services/websecurity.service";
import AgentToolsPanel from "@/components/session/AgentToolsPanel";
import { updateSessions } from "@/store/user.slice";
import { FiCheckSquare, FiMonitor, FiShield } from "react-icons/fi";
import { MdOutlineDeleteSweep } from "react-icons/md";
import { TbRadar } from "react-icons/tb";
import { HiOutlineChevronLeft } from "react-icons/hi";
import { useAgentStreamStore } from "@/store/agentStream.store";
import ContextUsageIndicator from "@/components/agent/ContextUsageIndicator";

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

  const navigateToBurp = () => {
    const burpId = `${sessionId}/burp`;
    let updatedSess = [...sessions];
    const exists = updatedSess.find((s) => s.id === burpId);
    if (!exists) {
      updatedSess = updatedSess.map((s) => ({ ...s, is_active: false }));
      updatedSess.push({ id: burpId, is_main: false, is_active: true, type: "burp" });
      dispatch(updateSessions(updatedSess));
    }
    router.push(`/session/${sessionId}/burp`);
  };

  const exitTarget = workspaceId
    ? `/workspace/${workspaceId}`
    : "/dashboard";

  const isOnWorkspace = pathname === `/session/${sessionId}`;
  const isOnGUI = pathname?.includes("/gui");
  const isOnBurp = pathname?.includes("/burp");
  const isOnVulnerabilities = pathname?.includes("/vulnerabilities");
  const isOnTestPlan = pathname?.includes("/test-plan");
  const contextUsageForTab = orchestratorTokenUsage;

  return (
    <div className={styles.sidebar}>
      <div className={styles.createNew}>
        <div className={styles.navRow}>
          <Tooltip title="All workspaces" placement="right">
            <button
              className={styles.navBtn}
              onClick={() => { dispatch(setRecon(false)); router.push("/dashboard"); }}
            >
              <HiOutlineChevronLeft size={12} />
            </button>
          </Tooltip>
          <button
            className={styles.navLabel}
            onClick={() => { dispatch(setRecon(false)); router.push(exitTarget); }}
          >
            {workspaceId ? "Workspace" : "Dashboard"}
          </button>
        </div>

        <Tooltip
          placement="right"
          title={toolExecutionMode === "auto"
            ? "Run automatically; built-in destructive-action protections still ask."
            : toolExecutionMode === "auto_approve"
              ? "A separate reviewer handles actions that cross an approval boundary. This does not replace host isolation."
              : "Ask before every tool action."}
        >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.45rem 0.75rem",
            marginBottom: "0.5rem",
            fontSize: "0.72rem",
            fontWeight: 500,
            color: "var(--secondary-text)",
            background: "var(--secondary-bg)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 6,
            cursor: "default",
            userSelect: "none",
            transition: "all 0.15s",
          }}
        >
          <FiShield size={12} style={{ flexShrink: 0 }} />
          <select
            aria-label="Tool execution mode"
            value={toolExecutionMode}
            disabled={updateCapabilitiesMutation.isLoading}
            onChange={(event) => handleExecutionModeChange(event.target.value)}
            style={{
              minWidth: 0,
              width: "100%",
              color: "var(--primary-text)",
              background: "transparent",
              border: 0,
              outline: 0,
              cursor: "pointer",
              fontSize: "0.72rem",
              // Makes the native option popup render dark instead of white.
              colorScheme: "dark",
            }}
          >
            <option value="auto">Auto run</option>
            <option value="auto_approve">Approve for me</option>
            <option value="requires_consent">Requires consent</option>
          </select>
        </div>
        </Tooltip>

        <AgentToolsPanel sessionId={sessionId} />

        <div className={styles.sessionOptions}>
          {sessions
            .filter((s) => s.is_main && s.type === "session")
            .map((sess) => (
              <div
                key={sess.id}
                onClick={() => handleClickTab(sess.id)}
                className={sess?.is_active ? styles.activeTab : styles.tab}
              >
                <Image src={quad} width={14} height={14} alt="" />
                Main Workspace
              </div>
            ))}

          {sessions
            .filter((s) => !s.is_main && s.type === "session")
            .map((sess, i) => (
              <div
                key={sess.id}
                onClick={() => handleClickTab(sess.id)}
                className={sess?.is_active ? styles.activeTab : styles.tab}
              >
                <Image src={rect} width={14} height={14} alt="" />
                Sub Workspace {i + 1}
              </div>
            ))}

          <div
            onClick={() => router.push(`/session/${sessionId}`)}
            className={isOnWorkspace ? styles.activeTab : styles.tab}
          >
            <Image src={quad} width={14} height={14} alt="" />
            Orchestrator
          </div>

          <div
            onClick={() => router.push(`/session/${sessionId}/test-plan`)}
            className={isOnTestPlan ? styles.activeTab : styles.tab}
          >
            <FiCheckSquare />
            <span style={{ flex: 1 }}>WSTG Test Plan</span>
            {testPlanCoverage?.total > 0 && (
              <span className={styles.navBadge}>
                {testPlanCoverage.executed}/{testPlanCoverage.total}
              </span>
            )}
          </div>

          <div
            onClick={() => router.push(`/session/${sessionId}/vulnerabilities`)}
            className={isOnVulnerabilities ? styles.activeTab : styles.tab}
          >
            <FiShield />
            <span style={{ flex: 1 }}>Vulnerabilities</span>
            {(vulnerabilitiesData?.total ?? 0) > 0 && (
              <span className={styles.navBadge}>{vulnerabilitiesData.total}</span>
            )}
          </div>

          <div
            onClick={navigateToGUI}
            className={isOnGUI ? styles.activeTab : styles.tab}
          >
            <FiMonitor />
            GUI
          </div>

          <div
            onClick={navigateToBurp}
            className={isOnBurp ? styles.activeTab : styles.tab}
          >
            <TbRadar />
            Burp
          </div>
        </div>
      </div>

      <div className={styles.additionalOptions}>
        {contextUsageForTab && <ContextUsageIndicator tokenUsage={contextUsageForTab} />}
        <div className={styles.supportStep}>
          <div
            className={styles.options}
            onClick={() => {
              modal.confirm({
                title: "Clear context?",
                content: "This will erase all conversation history for this session. The system prompt and shells will be preserved.",
                okText: "Clear",
                okType: "danger",
                cancelText: "Cancel",
                centered: true,
                async onOk() {
                  try {
                    await clearContext({ sessionId });
                    message.success("Context cleared");
                    window.dispatchEvent(new CustomEvent("context-cleared", { detail: { sessionId } }));
                    queryClient.invalidateQueries(["session-info", sessionId]);
                  } catch {
                    message.error("Failed to clear context");
                  }
                },
              });
            }}
          >
            <MdOutlineDeleteSweep size={15} />
            Clear Context
          </div>

        </div>
      </div>

    </div>
  );
};

export default Sidebar;
