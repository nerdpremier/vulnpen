"use client";

import { AuthContextProvider } from "@/components/common/auth/AuthContext";
import Loader from "@/components/common/loader/Loader";
import Sidebar from "@/components/common/Sidebar";
import HeaderLinks from "@/components/common/HeaderLinks";
import { HeaderActionsProvider } from "@/components/common/HeaderActions";
import AgentStreamConnector from "@/components/common/AgentStreamConnector";
import ModelSetupGate from "@/components/common/ModelSetupGate";
import MoonBackdrop from "@/components/common/ui/MoonBackdrop";
import { useAgentStreamStore } from "@/store/agentStream.store";
import React, { use } from "react";
import { useSelector } from "react-redux";
import { useQuery } from "react-query";
import { getSessionInfo } from "@/services/agent.service";
import styles from "@/styles/pages/Session.module.scss";

const SessionLayout = ({ children, params }) => {
  const { session_id } = use(params);
  const { user } = useSelector((state) => state.user);

  const { data: sessionInfo } = useQuery(
    ["session-info", session_id],
    () => getSessionInfo(session_id),
    { enabled: !!user && !!session_id, refetchInterval: 10000 }
  );

  // The rail's width is a property of this page, not of the rail component:
  // the account dock is rendered by the header, outside the rail's subtree,
  // and has to narrow with it. Publishing it here as `data-rail` gives both
  // one source — `Session.module.scss` turns it into `--moon-rail-w`.
  const railNarrow = useAgentStreamStore(
    (state) => state.sessions[session_id]?.sidebarExpanded === false
  );

  if (!user) {
    return <Loader />;
  }

  return (
    <AuthContextProvider>
      <AgentStreamConnector sessionId={session_id} />
      <HeaderActionsProvider>
        <div
          className={styles.sessionPage}
          data-rail={railNarrow ? "narrow" : "wide"}
        >
          <MoonBackdrop variant="page" />
          <Sidebar
            sessionId={session_id}
            workspaceId={sessionInfo?.workspaceId}
          />
          <div className={styles.sessionMainArea}>
            <HeaderLinks
              sessionId={session_id}
              sessionInfo={sessionInfo}
            />
            <div className={styles.sessionContent}>
              <ModelSetupGate>{children}</ModelSetupGate>
            </div>
          </div>
        </div>
      </HeaderActionsProvider>
    </AuthContextProvider>
  );
};

export default SessionLayout;
