import styles from "@/styles/pages/Dashboard.module.scss";
import { Input, message, Tooltip } from "antd";
import PrimaryButton from "@/components/common/PrimaryButton";
import { SearchOutlined, PlusOutlined, ArrowRightOutlined } from "@ant-design/icons";
import Loader from "@/components/common/loader/Loader";
import { useSelector, useDispatch } from "react-redux";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { useState, useMemo, useEffect } from "react";
import CreateWorkspaceModal from "./CreateWorkspaceModal";
import { getUserWorkspaces, deleteWorkspace } from "@/services/workspace.service";
import moment from "moment";
import { useRouter, useSearchParams } from "next/navigation";
import { FiTrash, FiFolder, FiShield, FiActivity, FiClock } from "react-icons/fi";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { resetSessions } from "@/store/user.slice";
import {
  AnimatedContent,
  EmptyState,
  MoonBackdrop,
  ShinyText,
  SpotlightCard,
  StatTile,
} from "@/components/common/ui";

const TYPE_CONFIG = {
  pentest: {
    label: "Pentest",
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
  const router = useRouter();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const { user } = useSelector((state) => state.user);
  const confirmPopUp = useConfirmPopUp();
  const dispatch = useDispatch();

  const launchWorkspace = searchParams.get("launch") === "true";

  const [show, setShow] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  const { data: workspacesData, isLoading } = useQuery(
    ["get-user-workspaces"],
    getUserWorkspaces,
    {
      enabled: !!user,
      refetchInterval: 10000,
    }
  );

  const filteredWorkspaces = useMemo(() => {
    if (!workspacesData) return [];
    const term = searchTerm.trim().toLowerCase();
    if (!term) return workspacesData;
    return workspacesData.filter(
      (w) =>
        (w.name || "").toLowerCase().includes(term) ||
        (w.description || "").toLowerCase().includes(term) ||
        (w.workspaceId || "").toLowerCase().includes(term)
    );
  }, [workspacesData, searchTerm]);

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
      content: "This workspace and all its sessions will be archived.",
      okText: "Delete",
      cancelText: "Cancel",
      onOk: async () => {
        await deleteWorkspaceMutation.mutateAsync({ workspaceId });
      },
    });
  };

  useEffect(() => {
    dispatch(resetSessions());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (launchWorkspace) {
      setShow(true);
    }
  }, [launchWorkspace]);

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
                <span className={styles.heroEyebrow}>Engagement console</span>
                <h1 className={styles.heroTitle}>
                  <ShinyText text="Workspaces" speed={6} />
                </h1>
                <p className={styles.heroDescription}>
                  Every engagement lives in its own workspace with its own
                  session, WSTG test plan, findings and report draft.
                </p>
              </div>

              <div className={styles.heroActions}>
                <Input
                  prefix={<SearchOutlined className={styles.searchIcon} />}
                  placeholder="Search workspaces..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  allowClear
                  className={styles.searchBox}
                  aria-label="Search workspaces"
                />
                <PrimaryButton
                  purpleFilled
                  icon={<PlusOutlined />}
                  onClick={() => setShow(true)}
                >
                  New workspace
                </PrimaryButton>
              </div>
            </div>

            <div className={styles.heroStats}>
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
            </div>
          </div>
        </section>

        <section className={styles.workspaceGrid}>
          <div className={styles.gridHeader}>
            <h2 className={styles.gridTitle}>
              {searchTerm ? "Search results" : "All workspaces"}
              <span className={styles.gridCount}>
                {filteredWorkspaces.length}
              </span>
            </h2>
            {searchTerm && (
              <button
                type="button"
                className={styles.clearSearch}
                onClick={() => setSearchTerm("")}
              >
                Clear search
              </button>
            )}
          </div>

          {filteredWorkspaces.length === 0 ? (
            <EmptyState
              icon={<FiShield />}
              title={
                hasWorkspaces
                  ? "No workspaces match your search"
                  : "Create your first workspace"
              }
              description={
                hasWorkspaces
                  ? `Nothing matches "${searchTerm}". Try a different name, description or workspace id.`
                  : "A workspace bundles one engagement: its target, its sessions, the WSTG test plan and the report draft."
              }
              actions={
                <PrimaryButton
                  purpleFilled
                  onClick={() =>
                    hasWorkspaces ? setSearchTerm("") : setShow(true)
                  }
                >
                  {hasWorkspaces ? "Clear search" : "Create workspace"}
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
                  <AnimatedContent
                    key={workspace.workspaceId}
                    as={SpotlightCard}
                    glare
                    delay={Math.min(index, 8) * 45}
                    className={`${styles.workspaceCard} ${
                      hasActivity ? styles.activeCard : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    onClick={() =>
                      router.push(`/workspace/${workspace.workspaceId}`)
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter")
                        router.push(`/workspace/${workspace.workspaceId}`);
                    }}
                  >
                    <div className={styles.cardHeader}>
                      <div className={styles.cardTitleRow}>
                        <span className={styles.cardIcon}>{typeConf.icon}</span>
                        <h3 className={styles.cardTitle}>{workspace.name}</h3>
                      </div>
                      <div
                        className={styles.cardActions}
                        onClick={(e) => e.stopPropagation()}
                      >
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
                    </div>

                    <p className={styles.cardDescription}>
                      {workspace.description ||
                        "No description yet - open the workspace to add one."}
                    </p>

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
                        <div className={`${styles.statItem} ${styles.statRunning}`}>
                          <span className={styles.liveDot} />
                          <span className={styles.statCount}>
                            {sessions.running}
                          </span>
                          <span className={styles.statLabel}>running</span>
                        </div>
                      )}
                      {sessions.waiting > 0 && (
                        <div className={`${styles.statItem} ${styles.statWaiting}`}>
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
