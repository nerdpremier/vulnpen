import styles from "@/styles/pages/WorkspaceDetail.module.scss";
import { message, Tooltip, Input, Form } from "antd";
import PrimaryButton from "@/components/common/PrimaryButton";
import {
  PlusOutlined,
  ArrowLeftOutlined,
  PlayCircleOutlined,
} from "@ant-design/icons";
import Loader from "@/components/common/loader/Loader";
import { useSelector } from "react-redux";
import { useQuery, useMutation, useQueryClient } from "react-query";
import { useState, useMemo, useCallback } from "react";
import {
  getWorkspaceDetail,
  createSessionInWorkspace,
} from "@/services/workspace.service";
import { deleteSession } from "@/services/agent.service";
import moment from "moment";
import { useRouter } from "next/navigation";
import { FiTrash, FiActivity, FiClock, FiShield } from "react-icons/fi";
import ModalComponent from "@/components/common/ModalComponent";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { useAgentStreamStore } from "@/store/agentStream.store";
import {
  AnimatedContent,
  EmptyState,
  MoonBackdrop,
  ShinyText,
  StatTile,
} from "@/components/common/ui";

const STATE_DOT = {
  running: { color: "var(--moon-success)", label: "Running" },
  idle: { color: "var(--moon-text-mute)", label: "Idle" },
  paused: { color: "var(--moon-warning)", label: "Paused" },
  waiting_consent: { color: "var(--moon-warning)", label: "Waiting" },
  waiting_manual_execution: { color: "var(--moon-warning)", label: "Waiting" },
};

const WorkspaceDetailPage = ({ workspaceId }) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { user } = useSelector((state) => state.user);
  const confirmPopUp = useConfirmPopUp();

  const [showNewSession, setShowNewSession] = useState(false);
  const [newSessionForm] = Form.useForm();

  const { data: workspace, isLoading } = useQuery(
    ["workspace-detail", workspaceId],
    () => getWorkspaceDetail(workspaceId),
    { enabled: !!user && !!workspaceId, refetchInterval: 8000 }
  );

  const createSessionMutation = useMutation(
    (values) => createSessionInWorkspace({ workspaceId, ...values }),
    {
      onSuccess: (data) => {
        message.success("Session created!");
        queryClient.invalidateQueries(["workspace-detail", workspaceId]);
        setShowNewSession(false);
        newSessionForm.resetFields();
        router.push(`/session/${data.sessionId}`);
      },
      onError: (err) => {
        message.error(err?.response?.data?.message ?? "Failed to create session");
      },
    }
  );

  const deleteSessionMutation = useMutation(deleteSession, {
    onSuccess: (_data, variables) => {
      message.success("Session deleted");
      // Abort any in-flight stream and drop the cached store entry, otherwise
      // the deleted session keeps streaming events into a zombie entry.
      useAgentStreamStore.getState().clearSession(variables?.sessionId);
      queryClient.invalidateQueries(["workspace-detail", workspaceId]);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Failed to delete session");
    },
  });

  const onDeleteSession = useCallback(
    (sessionId, e) => {
      e?.stopPropagation?.();
      confirmPopUp({
        title: "Delete session?",
        content: "This session will be permanently deleted.",
        okText: "Delete",
        cancelText: "Cancel",
        onOk: async () => {
          await deleteSessionMutation.mutateAsync({ sessionId });
        },
      });
    },
    [confirmPopUp, deleteSessionMutation]
  );

  const sessions = useMemo(
    () => workspace?.sessions || [],
    [workspace?.sessions]
  );

  const stateCounts = useMemo(() => {
    return sessions.reduce(
      (acc, session) => {
        if (session.agentState === "running") acc.running += 1;
        else if (String(session.agentState || "").startsWith("waiting"))
          acc.waiting += 1;
        else acc.idle += 1;
        return acc;
      },
      { running: 0, waiting: 0, idle: 0 }
    );
  }, [sessions]);

  const isPentest = workspace?.type === "pentest";

  if (!user || isLoading || !workspace) {
    return <Loader />;
  }

  return (
    <div className={styles.container}>
      <section className={styles.hero}>
        <MoonBackdrop variant="hero" />
        <div className={styles.heroContent}>
          <div className={styles.heroTop}>
            <button
              type="button"
              className={styles.backBtn}
              onClick={() => router.push("/dashboard")}
            >
              <ArrowLeftOutlined /> All workspaces
            </button>
            <span className={styles.typeChip}>
              <FiShield size={12} />
              {isPentest ? "Web Security Testing" : "General workspace"}
            </span>
          </div>

          <div className={styles.heroRow}>
            <div className={styles.heroText}>
              <h1 className={styles.heroTitle}>
                <ShinyText text={workspace.name} speed={7} />
              </h1>
              {workspace.description && (
                <p className={styles.heroDescription}>{workspace.description}</p>
              )}
            </div>
            <PrimaryButton
              purpleFilled
              icon={<PlusOutlined />}
              onClick={() => setShowNewSession(true)}
            >
              New session
            </PrimaryButton>
          </div>

          <div className={styles.heroStats}>
            <StatTile label="Sessions" value={sessions.length} />
            <StatTile
              label="Running"
              value={stateCounts.running}
              tone="success"
              icon={<span className={styles.liveDot} />}
            />
            <StatTile
              label="Waiting"
              value={stateCounts.waiting}
              tone="warning"
              icon={<FiClock />}
            />
            <StatTile
              label="Idle"
              value={stateCounts.idle}
              icon={<FiActivity />}
            />
          </div>
        </div>
      </section>

      <div className={styles.content}>
        <div className={styles.sectionHeader}>
          <h2>Sessions</h2>
          <span className={styles.sessionCount}>
            {`${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {sessions.length === 0 ? (
          <EmptyState
            icon={<PlayCircleOutlined />}
            title="No sessions yet"
            description="A session is one engagement workspace: the orchestrator, its shells, the WSTG test plan and the findings it records."
            actions={
              <PrimaryButton
                purpleFilled
                icon={<PlusOutlined />}
                onClick={() => setShowNewSession(true)}
              >
                Create the first session
              </PrimaryButton>
            }
          />
        ) : (
          <div className={styles.sessionTable}>
            <div className={styles.sessionTableHeader}>
              <span>Session</span>
              <span>Status</span>
              <span>Created</span>
              <span className={styles.sessionActionCol}>Actions</span>
            </div>
            {sessions.map((session, index) => {
              const stateInfo = STATE_DOT[session.agentState] || STATE_DOT.idle;

              return (
                <AnimatedContent
                  key={session.sessionId}
                  direction="none"
                  delay={Math.min(index, 10) * 30}
                  className={`${styles.sessionTableRow} ${
                    session.agentState === "running"
                      ? styles.sessionTableRowRunning
                      : ""
                  }`}
                  role="button"
                  tabIndex={0}
                  onClick={() => router.push(`/session/${session.sessionId}`)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter")
                      router.push(`/session/${session.sessionId}`);
                  }}
                >
                  <span className={styles.sessionNameCell}>
                    <span className={styles.sessionNameInner}>
                      <Tooltip title={stateInfo.label}>
                        <span
                          className={styles.stateDot}
                          style={{ background: stateInfo.color }}
                        />
                      </Tooltip>
                      <span className={styles.sessionNameText}>
                        {session.name}
                      </span>
                    </span>
                    {session.description && (
                      <span className={styles.sessionDescInline}>
                        {session.description}
                      </span>
                    )}
                  </span>
                  <span>
                    <span
                      className={`${styles.agentStateBadge} ${
                        styles[`agentState_${session.agentState || "idle"}`]
                      }`}
                    >
                      {stateInfo.label}
                    </span>
                  </span>
                  <span className={styles.sessionDateCol}>
                    {moment(session.createdAt).format("MMM D, YYYY")}
                  </span>
                  <span
                    className={styles.sessionActionCol}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Tooltip title="Open">
                      <button
                        type="button"
                        className={styles.openBtn}
                        onClick={() =>
                          router.push(`/session/${session.sessionId}`)
                        }
                      >
                        Open
                      </button>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <button
                        type="button"
                        className={styles.sessionActionBtn}
                        aria-label={`Delete ${session.name}`}
                        onClick={(e) => onDeleteSession(session.sessionId, e)}
                      >
                        <FiTrash size={11} />
                      </button>
                    </Tooltip>
                  </span>
                </AnimatedContent>
              );
            })}
          </div>
        )}
      </div>

      <ModalComponent
        show={showNewSession}
        setShow={setShowNewSession}
        heading="New session"
        onCancel={() => {
          setShowNewSession(false);
          newSessionForm.resetFields();
        }}
        destroyOnHidden
        width={500}
      >
        <div className={styles.formWrap}>
          <Form
            form={newSessionForm}
            layout="vertical"
            onFinish={createSessionMutation.mutate}
          >
            <Form.Item
              name="name"
              label="Session name"
              rules={[{ required: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g. Target A - login and session handling" />
            </Form.Item>
            <div className={styles.formActions}>
              <PrimaryButton
                onClick={() => {
                  setShowNewSession(false);
                  newSessionForm.resetFields();
                }}
              >
                Cancel
              </PrimaryButton>
              <PrimaryButton
                purpleFilled
                htmlType="submit"
                loading={createSessionMutation.isLoading}
              >
                Create session
              </PrimaryButton>
            </div>
          </Form>
        </div>
      </ModalComponent>
    </div>
  );
};

export default WorkspaceDetailPage;
