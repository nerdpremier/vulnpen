import ModalComponent from "@/components/common/ModalComponent";
import PrimaryButton from "@/components/common/PrimaryButton";
import { Form, Input, message, Row } from "antd";
import styles from "@/styles/pages/Dashboard.module.scss";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "react-query";
import { createWorkspace } from "@/services/workspace.service";
import { useState, useCallback } from "react";
import { FiShield } from "react-icons/fi";

const CreateWorkspaceModal = ({ show, setShow, close }) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [form] = Form.useForm();
  const [workspaceType, setWorkspaceType] = useState("pentest");

  const resetState = useCallback(() => {
    setWorkspaceType("pentest");
    form.resetFields();
  }, [form]);

  const handleClose = () => {
    resetState();
    close();
  };

  const createWorkspaceMutation = useMutation(createWorkspace, {
    onSuccess: (data) => {
      queryClient.invalidateQueries(["get-user-workspaces"]);

      message.success("Workspace created!");
      router.push(`/workspace/${data.workspaceId}`);
      handleClose();
    },
    onError: (error) => {
      message.error(
        error?.response?.data?.message ?? "Failed to create workspace!"
      );
    },
  });

  const handleStep1 = async (values) => {
    const type = workspaceType;
    await createWorkspaceMutation.mutateAsync({
      name: values.name,
      description: values.description,
      type,
    });
  };

  return (
    <ModalComponent
      show={show}
      setShow={setShow}
      heading="Create new workspace"
      subheading="Set up a workspace for your engagement"
      onCancel={handleClose}
      footer={false}
      destroyOnClose
      width={"80%"}
    >
      <div className={styles.createSession}>
        <Form form={form} layout="vertical" onFinish={handleStep1}>
            <Form.Item
              name="name"
              label="Workspace name"
              rules={[{ required: true, message: "Name is required" }]}
            >
              <Input placeholder="e.g. Client Pentest" />
            </Form.Item>

            <Form.Item label="Workspace type">
              <div className={styles.typeSelector}>
                {[
                  { key: "pentest", label: "Pentest", icon: <FiShield />, desc: "OWASP Web Security Testing Guide" },
                ].map((t) => (
                  <div
                    key={t.key}
                    className={`${styles.typeOption} ${workspaceType === t.key ? styles.typeSelected : ""}`}
                    onClick={() => setWorkspaceType(t.key)}
                  >
                    <span className={styles.typeIcon}>{t.icon}</span>
                    <span className={styles.typeLabel}>{t.label}</span>
                    <span className={styles.typeDesc}>{t.desc}</span>
                  </div>
                ))}
              </div>
            </Form.Item>

            <Row justify="end">
              <PrimaryButton
                purple
                htmlType="submit"
                loading={createWorkspaceMutation.isLoading}
              >
                Create Workspace
              </PrimaryButton>
            </Row>
          </Form>
      </div>
    </ModalComponent>
  );
};

export default CreateWorkspaceModal;
