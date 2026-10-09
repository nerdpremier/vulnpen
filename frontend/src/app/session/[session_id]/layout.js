"use client";

import { AuthContextProvider } from "@/components/common/auth/AuthContext";
import Loader from "@/components/common/loader/Loader";
import Sidebar from "@/components/common/Sidebar";
import HeaderLinks from "@/components/common/HeaderLinks";
import { HeaderActionsProvider } from "@/components/common/HeaderActions";
import AgentStreamConnector from "@/components/common/AgentStreamConnector";
import ModelSetupGate from "@/components/common/ModelSetupGate";
import MoonBackdrop from "@/components/common/ui/MoonBackdrop";
import React, { use } from "react";
import { useSelector } from "react-redux";
import { useQuery } from "react-query";
import { getSessionInfo } from "@/services/agent.service";
import styles from "@/styles/pages/Session.module.scss";

const SessionLayout = ({ children, params }) => {
  const { session_id } = use(params);
  const { user, sessions } = useSelector((state) => state.user);

  const { data: sessionInfo } = useQuery(
    ["session-info", session_id],
    () => getSessionInfo(session_id),
    { enabled: !!user && !!session_id, refetchInterval: 10000 }
  );

  if (!user) {
    return <Loader />;
  }

  // The workspace rail knows the display name; session-info fills the gap when
  // the session was opened from a deep link.
  const currentSession = sessions?.find((s) => s.id === session_id);

  return (
    <AuthContextProvider>
      <AgentStreamConnector sessionId={session_id} />
      <HeaderActionsProvider>
        <div className={styles.sessionPage}>
          <MoonBackdrop variant="page" />
          <Sidebar
            sessionId={session_id}
            workspaceId={sessionInfo?.workspaceId}
          />
          <div className={styles.sessionMainArea}>
            <HeaderLinks
              sessionId={session_id}
              sessionName={currentSession?.name}
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
