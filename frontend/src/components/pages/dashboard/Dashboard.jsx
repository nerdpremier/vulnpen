import styles from "@/styles/pages/Dashboard.module.scss";
import { message, Tooltip } from "antd";
import PrimaryButton from "@/components/common/PrimaryButton";
import { PlusOutlined, ArrowRightOutlined } from "@ant-design/icons";
import Loader from "@/components/common/loader/Loader";
import { useSelector } from "react-redux";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { useState, useMemo } from "react";
import CreateWorkspaceModal from "./CreateWorkspaceModal";
import { getUserWorkspaces, deleteWorkspace } from "@/services/workspace.service";
import moment from "moment";
import Link from "next/link";
import { FiTrash, FiFolder, FiShield, FiActivity, FiClock } from "react-icons/fi";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import {
  AnimatedContent,
  EmptyState,
  MoonBackdrop,
  PageState,
  ShinyText,
  SpotlightCard,
  StatStrip,
  StatTile,
} from "@/components/common/ui";

const TYPE_CONFIG = {
  pentest: {
    label: "Web Security Testing",
    icon: <FiShield size={12} />,
    note: "OWASP WSTG v4.2",
  },
  general: {
    label: "General",
    icon: <FiFolder size={12} />,
    note: "General purpose",
  },
};

const DashboardPage = () => {
  const queryClient = useQueryClient();
  const { user } = useSelector((state) => state.user);
  const confirmPopUp = useConfirmPopUp();

  const [show, setShow] = useState(false);

  const { data: workspacesData, isLoading, isError, refetch } = useQuery(
    ["get-user-workspaces"],
    getUserWorkspaces,
    {
      enabled: !!user,
      refetchInterval: 10000,
    }
  );

  const filteredWorkspaces = useMemo(() => {
    if (!workspacesData) return [];
    return workspacesData;
  }, [workspacesData]);

  // Roll the workspace list up into the header metrics once per change instead
  // of recomputing inside every card.
  const totals = useMemo(() => {
    const list = workspacesData || [];
    return list.reduce(
      (acc, workspace) => {
        const s = workspace.sessions || {};
        acc.sessions += s.total || 0;
        acc.running += s.running || 0;
        acc.waiting += s.waiting || 0;
        return acc;
      },
      { sessions: 0, running: 0, waiting: 0 }
    );
  }, [workspacesData]);

  const deleteWorkspaceMutation = useMutation(deleteWorkspace, {
    onSuccess: (data) => {
      message.success(data?.message ?? "Workspace deleted successfully!");
      queryClient.invalidateQueries(["get-user-workspaces"]);
    },
    onError: (error) => {
      message.error(
        error?.response?.data?.message ?? "Failed to delete workspace!"
      );
    },
  });

  const onDeleteWorkspace = (workspaceId, e) => {
    e?.stopPropagation?.();
    confirmPopUp({
      title: "Delete workspace?",
      content: "This workspace and all its sessions will be permanently deleted.",
      okText: "Delete",
      cancelText: "Cancel",
      onOk: async () => {
        await deleteWorkspaceMutation.mutateAsync({ workspaceId });
      },
    });
  };

  if (!user || isLoading) {
    return <Loader />;
  }

  const hasWorkspaces = (workspacesData?.length || 0) > 0;

  return (
    <>
      <div className={styles.dashboardContainer}>
        <section className={styles.dashboardHero}>
          <MoonBackdrop variant="hero" />
          <div className={styles.heroContent}>
            <div className={styles.heroRow}>
              <div className={styles.heroText}>
                <h1 className={styles.heroTitle}>
                  <ShinyText text="Dashboard" speed={6} />
                </h1>
              </div>
            </div>

            <StatStrip className={styles.heroStats}>
              <StatTile
                label="Workspaces"
                value={workspacesData?.length || 0}
                icon={<FiFolder />}
              />
              <StatTile
                label="Sessions"
                value={totals.sessions}
                icon={<FiActivity />}
              />
              <StatTile
                label="Running"
                value={totals.running}
                tone="success"
                icon={<span className={styles.liveDot} />}
                hint={totals.running ? "Agent is working" : "Nothing running"}
              />
              <StatTile
                label="Waiting"
                value={totals.waiting}
                tone="warning"
                icon={<FiClock />}
                hint={
                  totals.waiting ? "Needs your approval" : "No approvals pending"
                }
              />
            </StatStrip>
          </div>
        </section>

        <section className={styles.workspaceGrid}>
          <div className={styles.gridHeader}>
            <h2 className={styles.gridTitle}>
              All workspaces
              <span className={styles.gridCount}>
                {filteredWorkspaces.length}
              </span>
            </h2>
            <PrimaryButton
              purpleFilled
              icon={<PlusOutlined />}
              onClick={() => setShow(true)}
            >
              New workspace
            </PrimaryButton>
          </div>

          {isError ? (
            /* A failed read used to render "Create your first workspace", which
               invites the operator to build a workspace they already have. */
            <PageState
              state="error"
              title="Could not load your workspaces"
              description="Your workspaces are unchanged. Retry, or check the backend and reload."
              onRetry={() => refetch()}
            />
          ) : filteredWorkspaces.length === 0 ? (
            <EmptyState
              icon={<FiFolder />}
              title={
                hasWorkspaces
                  ? "No workspaces found"
                  : "Create your first workspace"
              }
              description={
                hasWorkspaces
                  ? "Nothing to show yet. Create a workspace to get started."
                  : "A workspace holds one engagement: its target, its sessions and its findings."
              }
              actions={
                <PrimaryButton purpleFilled onClick={() => setShow(true)}>
                  Create workspace
                </PrimaryButton>
              }
            />
          ) : (
            <div className={styles.cardGrid}>
              {filteredWorkspaces.map((workspace, index) => {
                const typeConf =
                  TYPE_CONFIG[workspace.type] || TYPE_CONFIG.general;
                const sessions = workspace.sessions || {};
                const hasActivity =
                  sessions.running > 0 || sessions.waiting > 0;

                return (
                  /* The card is a real link, so the browser can open it in a
                     new tab and the keyboard reaches it with one Tab. The
                     delete button is a sibling *outside* the anchor: an
                     interactive control nested in a link is invalid HTML and
                     swallows its own clicks. */
                  <AnimatedContent
                    key={workspace.workspaceId}
                    delay={Math.min(index, 8) * 45}
                    className={styles.cardShell}
                  >
                    <SpotlightCard
                      as={Link}
                      href={`/workspace/${workspace.workspaceId}`}
                      glare
                      className={`${styles.workspaceCard} ${
                        hasActivity ? styles.activeCard : ""
                      }`}
                    >
                      <div className={styles.cardHeader}>
                        <div className={styles.cardTitleRow}>
                          <h3 className={styles.cardTitle}>{workspace.name}</h3>
                        </div>
                      </div>

                      {workspace.description && (
                        <p className={styles.cardDescription}>
                          {workspace.description}
                        </p>
                      )}

                      <div className={styles.cardMeta}>
                        <span className={styles.typeChip}>
                          {typeConf.icon}
                          {typeConf.label}
                        </span>
                        <span className={styles.cardDate}>
                          {moment(workspace.createdAt).format("MMM D, YYYY")}
                        </span>
                      </div>

                      <div className={styles.sessionStats}>
                        <div className={styles.statItem}>
                          <span className={styles.statCount}>
                            {sessions.total || 0}
                          </span>
                          <span className={styles.statLabel}>
                            {sessions.total === 1 ? "session" : "sessions"}
                          </span>
                        </div>
                        {sessions.running > 0 && (
                          <div
                            className={`${styles.statItem} ${styles.statRunning}`}
                          >
                            <span className={styles.liveDot} />
                            <span className={styles.statCount}>
                              {sessions.running}
                            </span>
                            <span className={styles.statLabel}>running</span>
                          </div>
                        )}
                        {sessions.waiting > 0 && (
                          <div
                            className={`${styles.statItem} ${styles.statWaiting}`}
                          >
                            <span className={styles.waitDot} />
                            <span className={styles.statCount}>
                              {sessions.waiting}
                            </span>
                            <span className={styles.statLabel}>waiting</span>
                          </div>
                        )}
                      </div>

                      <span className={styles.cardOpen}>
                        Open workspace
                        <ArrowRightOutlined />
                      </span>
                    </SpotlightCard>

                    <div className={styles.cardActions}>
                      <Tooltip title="Delete workspace">
                        <button
                          type="button"
                          className={styles.deleteBtn}
                          aria-label={`Delete ${workspace.name}`}
                          onClick={(e) =>
                            onDeleteWorkspace(workspace.workspaceId, e)
                          }
                        >
                          <FiTrash size={13} />
                        </button>
                      </Tooltip>
                    </div>
                  </AnimatedContent>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <CreateWorkspaceModal
        show={show}
        setShow={setShow}
        close={() => setShow(false)}
      />
    </>
  );
};

export default DashboardPage;
