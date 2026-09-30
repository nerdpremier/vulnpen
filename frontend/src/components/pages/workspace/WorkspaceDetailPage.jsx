import styles from "@/styles/pages/WorkspaceDetail.module.scss";
import { message, Tag, Tooltip, Input, Form, Empty, Button } from "antd";
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
import { getWorkspaceDetail, createSessionInWorkspace } from "@/services/workspace.service";
import { deleteSession } from "@/services/agent.service";
import moment from "moment";
import { useRouter } from "next/navigation";
import { FiTrash } from "react-icons/fi";
import ModalComponent from "@/components/common/ModalComponent";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";

const STATE_DOT = {
  running: { color: "#10ca00", label: "Running" },
  idle: { color: "#6b7280", label: "Idle" },
  paused: { color: "#d29922", label: "Paused" },
  waiting_consent: { color: "#d29922", label: "Waiting" },
  waiting_manual_execution: { color: "#d29922", label: "Waiting" },
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
    onSuccess: () => {
      message.success("Session deleted");
      queryClient.invalidateQueries(["workspace-detail", workspaceId]);
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Failed to delete session");
    },
  });

  const onDeleteSession = useCallback((sessionId, e) => {
    e?.stopPropagation?.();
    confirmPopUp({
      title: "Delete session?",
      content: "This session will be archived.",
      okText: "Delete",
      cancelText: "Cancel",
      onOk: async () => {
        await deleteSessionMutation.mutateAsync({ sessionId });
      },
    });
  }, [confirmPopUp, deleteSessionMutation]);

  const sessions = useMemo(
    () => workspace?.sessions || [],
    [workspace?.sessions],
  );

  if (!user || isLoading || !workspace) {
    return <Loader />;
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.backBtn}
            onClick={() => router.push("/dashboard")}
          >
            <ArrowLeftOutlined /> Back
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1>{workspace.name}</h1>
              <Tag className={styles.typeBadge} color={
                workspace.type === "pentest" ? "#8b5cf6" : "#6b7280"
              }>
                {workspace.type?.toUpperCase()}
              </Tag>
            </div>
            {workspace.description ? (
              <p className={styles.description}>{workspace.description}</p>
            ) : null}
          </div>
        </div>
        <div className={styles.headerRight}>
          <PrimaryButton purple onClick={() => setShowNewSession(true)} className={styles.compactBtn}>
            <PlusOutlined /> New Session
          </PrimaryButton>
        </div>
      </div>

      <div className={styles.content}>
        <div className={styles.sectionHeader}>
          <h2>Sessions</h2>
          <span className={styles.sessionCount}>
            {`${sessions.length} session${sessions.length !== 1 ? "s" : ""}`}
          </span>
        </div>

        {sessions.length === 0 ? (
          <div className={styles.emptyState}>
            <Empty
              description="Create a session to get started"
            />
          </div>
        ) : (
          <div className={styles.sessionTable}>
            <div className={styles.sessionTableHeader}>
              <span>Session</span>
              <span>Status</span>
              <span>Created</span>
              <span style={{ textAlign: "right" }}>Actions</span>
            </div>
            {sessions.map((session) => {
              const stateInfo = STATE_DOT[session.agentState] || STATE_DOT.idle;

              return (
                <div
                  key={session.sessionId}
                  className={`${styles.sessionTableRow} ${session.agentState === "running" ? styles.sessionTableRowRunning : ""}`}
                  onClick={() => router.push(`/session/${session.sessionId}`)}
                >
                  <span className={styles.sessionNameCell}>
                    <span className={styles.sessionNameInner}>
                      <Tooltip title={stateInfo.label}>
                        <span className={styles.stateDot} style={{ background: stateInfo.color }} />
                      </Tooltip>
                      <span className={styles.sessionNameText}>{session.name}</span>
                    </span>
                    {session.description && (
                      <span className={styles.sessionDescInline}>{session.description}</span>
                    )}
                  </span>
                  <span>
                    <span className={`${styles.agentStateBadge} ${styles[`agentState_${session.agentState || "idle"}`]}`}>
                      {stateInfo.label}
                    </span>
                  </span>
                  <span className={styles.sessionDateCol}>
                    {moment(session.createdAt).format("MMM D, YYYY")}
                  </span>
                  <span className={styles.sessionActionCol} onClick={(e) => e.stopPropagation()}>
                    <Tooltip title="Open">
                      <Button
                        size="small"
                        type="default"
                        icon={<PlayCircleOutlined />}
                        onClick={() => router.push(`/session/${session.sessionId}`)}
                        className={styles.openBtn}
                      >
                        Open
                      </Button>
                    </Tooltip>
                    <Tooltip title="Delete">
                      <div
                        className={styles.sessionActionBtn}
                        onClick={(e) => onDeleteSession(session.sessionId, e)}
                      >
                        <FiTrash size={11} />
                      </div>
                    </Tooltip>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* New Session Modal */}
      <ModalComponent
        show={showNewSession}
        setShow={setShowNewSession}
        heading="New session"
        subheading={`Create a session in "${workspace.name}"`}
        onCancel={() => { setShowNewSession(false); newSessionForm.resetFields(); }}
        footer={false}
        destroyOnHidden
        width={500}
      >
        <div className={styles.formWrap}>
          <Form form={newSessionForm} layout="vertical" onFinish={createSessionMutation.mutate}>
            <Form.Item
              name="name"
              label="Session name"
              rules={[{ required: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g. buffer-overflow, Target A" />
            </Form.Item>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <PrimaryButton white onClick={() => { setShowNewSession(false); newSessionForm.resetFields(); }}>
                Cancel
              </PrimaryButton>
              <PrimaryButton purple htmlType="submit" loading={createSessionMutation.isLoading}>
                Create Session
              </PrimaryButton>
            </div>
          </Form>
        </div>
      </ModalComponent>
    </div>
  );
};

export default WorkspaceDetailPage;
