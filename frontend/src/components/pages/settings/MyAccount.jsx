"use client";

import React, { useMemo, useState } from "react";
import styles from "@/styles/pages/Settings.module.scss";
import { App, Button, Form, Input, Modal } from "antd";
import { useSelector } from "react-redux";
import { debounce } from "lodash";
import { updateUserProfile } from "@/services/user.service";
import { changePassword } from "@/services/auth.service";
import { useMutation, useQueryClient } from "react-query";

const MyAccount = () => {
  const queryClient = useQueryClient();
  const { user } = useSelector((state) => state.user);
  const { message } = App.useApp();

  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordForm] = Form.useForm();

  const { mutateAsync: updateUserProfileAsync } = useMutation(updateUserProfile, {
    onSuccess: async () => {
      message.success("Profile updated");
      await queryClient.invalidateQueries("check-session");
    },
    onError: (err) => {
      message.error(err?.response?.data?.message ?? "Failed to update profile");
    },
  });

  const { mutateAsync: changePasswordAsync, isLoading: isChangingPassword } =
    useMutation(changePassword, {
      onSuccess: (data) => {
        message.success(data?.message ?? "Password updated");
        setPasswordOpen(false);
      },
      onError: (err) => {
        message.error(
          err?.response?.data?.message ?? "Failed to update password"
        );
      },
    });

  const handleUpdateName = useMemo(
    () => debounce(async ({ name }) => {
      if (name.length < 3 || name.length > 30) return;
      await updateUserProfileAsync({ name });
    }, 500),
    [updateUserProfileAsync],
  );

  const handleChangePassword = async (values) => {
    try {
      await changePasswordAsync(values);
    } catch {
      // The mutation's onError already told the operator what went wrong; the
      // modal stays open so the fields keep their values.
    }
  };

  return (
    <div className={styles.settingsContainer}>
      <Form onValuesChange={handleUpdateName} layout="vertical" initialValues={{ name: user.name }}>
        <Form.Item
          label="Name"
          name="name"
          rules={[
            { required: true, message: "Please enter your name" },
            { min: 3, message: "Name must be minimum 3 characters." },
            { max: 30, message: "Name must be maximum 30 characters." },
          ]}
        >
          <Input />
        </Form.Item>
      </Form>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Email</label>
        <div className={styles.fieldValue}>{user.email}</div>
      </div>

      <div className={styles.fieldGroup}>
        <label className={styles.fieldLabel}>Password</label>
        <div className={styles.passwordRow}>
          <span className={styles.fieldHint}>
            The password you sign in with on this installation.
          </span>
          <Button onClick={() => setPasswordOpen(true)}>Reset password</Button>
        </div>
      </div>

      <Modal
        title="Reset password"
        open={passwordOpen}
        onCancel={() => setPasswordOpen(false)}
        footer={null}
        width={440}
        centered
        destroyOnHidden
      >
        <Form
          form={passwordForm}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          onFinish={handleChangePassword}
        >
          <Form.Item
            label="Current password"
            name="currentPassword"
            rules={[
              { required: true, message: "Please enter your current password" },
            ]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>

          <Form.Item
            label="New password"
            name="newPassword"
            rules={[
              { required: true, message: "Please enter a new password" },
              { min: 8, message: "Password must be at least 8 characters." },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          <Form.Item
            label="Confirm new password"
            name="confirmPassword"
            dependencies={["newPassword"]}
            rules={[
              { required: true, message: "Please confirm the new password" },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue("newPassword") === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error("Passwords do not match"));
                },
              }),
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          <div className={styles.passwordActions}>
            <Button onClick={() => setPasswordOpen(false)}>Cancel</Button>
            <Button
              htmlType="submit"
              type="primary"
              loading={isChangingPassword}
            >
              Update password
            </Button>
          </div>
        </Form>
      </Modal>
    </div>
  );
};

export default MyAccount;
