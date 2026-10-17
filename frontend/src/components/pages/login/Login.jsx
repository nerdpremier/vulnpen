import { useState } from "react";
import { App, Button, Form, Input } from "antd";

import styles from "@/styles/pages/Login.module.scss";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getRegistrationStatus, login, resetPassword } from "@/services/auth.service";
import Link from "next/link";
import { loginUser } from "@/store/user.slice";
import { useDispatch } from "react-redux";
import { AnimatedContent, MoonBackdrop, ShinyText } from "@/components/common/ui";
import ModalComponent from "@/components/common/ModalComponent";

const LoginPage = () => {
  const router = useRouter();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
  const [forgotOpen, setForgotOpen] = useState(false);
  const [loginForm] = Form.useForm();
  const [resetForm] = Form.useForm();
  const { data: registrationStatus } = useQuery(
    "registration-status",
    getRegistrationStatus
  );

  const loginMutation = useMutation(login, {
    onError: (error) => {
      message.error(
        error?.response?.data?.message ??
          "Failed to login, please try again later!"
      );
    },
    onSuccess: async (data) => {
      message.success(data?.message ?? "Logged in successfully!");
      localStorage.removeItem("antiCSRF");
      dispatch(loginUser(data.user));
      await queryClient.invalidateQueries("check-session");
      router.push("/dashboard");
    },
  });

  const handleLogin = (values) => {
    loginMutation.mutate({
      email: values.email,
      password: values.password,
    });
  };

  const resetMutation = useMutation(resetPassword, {
    onError: (error) => {
      message.error(
        error?.response?.data?.message ?? "Failed to reset the password"
      );
    },
    onSuccess: (data, variables) => {
      message.success(data?.message ?? "Password updated");
      setForgotOpen(false);
      resetForm.resetFields();
      // The account is now reachable again: put the address in the sign-in
      // form so the next step is only the new password.
      loginForm.setFieldsValue({ email: variables.email, password: "" });
    },
  });

  return (
    <div className={styles.authShell}>
      <MoonBackdrop variant="page" />

      <main className={styles.authPanel}>
        <AnimatedContent className={styles.authStack} direction="up">
          <div className={styles.authCard}>
            <span className={styles.authEyebrow}>Sign in</span>
            <h1 className={styles.authTitle}>
              Welcome to{" "}
              <ShinyText text="VulnPen" className={styles.authWord} />
            </h1>
            <p className={styles.authSubtitle}>
              AI assistant for web application security testing.
            </p>

            <Form
              form={loginForm}
              className={styles.authForm}
              layout="vertical"
              onFinish={handleLogin}
              requiredMark={false}
            >
              <Form.Item
                name="email"
                label="Email"
                rules={[
                  { required: true, message: "Please enter your email" },
                  { type: "email", message: "Invalid email" },
                ]}
              >
                <Input placeholder="you@company.com" autoComplete="email" />
              </Form.Item>

              <Form.Item
                name="password"
                label="Password"
                rules={[{ required: true, message: "Please enter your password" }]}
              >
                <Input.Password
                  placeholder="Your password"
                  autoComplete="current-password"
                />
              </Form.Item>

              <div className={styles.forgotRow}>
                <button
                  type="button"
                  className={styles.forgotLink}
                  onClick={() => setForgotOpen(true)}
                >
                  Forgot password?
                </button>
              </div>

              <Form.Item className={styles.authSubmit}>
                <Button
                  htmlType="submit"
                  type="primary"
                  block
                  loading={loginMutation.isLoading}
                >
                  Sign in
                </Button>
              </Form.Item>
            </Form>

            {/* Only a *closed* registration hides the way in. A transient failure
                to read the status must not be mistaken for "registration is off",
                or a new user is left with no door. */}
            {registrationStatus?.registrationOpen !== false && (
              <Link className={styles.authLink} href="/register">
                New here? Create an account
              </Link>
            )}
          </div>
        </AnimatedContent>
      </main>

      {/* Reset from the sign-in page: the address selects the account and the
          new password is set immediately — no email, no code, no owner step.
          The body reuses the sign-in card's own type scale and form styles so
          it reads as the same surface, not as a generic settings dialog. */}
      <ModalComponent
        show={forgotOpen}
        setShow={setForgotOpen}
        width={430}
        maxWidth="92vw"
        destroyOnClose
      >
        <span className={styles.authEyebrow}>Reset password</span>
        <h1 className={styles.authTitle}>Forgot your password?</h1>
        <p className={styles.authSubtitle}>
          Enter your email and choose a new password.
        </p>

        <Form
          className={styles.authForm}
          form={resetForm}
          layout="vertical"
          requiredMark={false}
          preserve={false}
          onFinish={(values) => resetMutation.mutate(values)}
        >
          <Form.Item
            name="email"
            label="Email"
            rules={[
              { required: true, message: "Please enter your email" },
              { type: "email", message: "Invalid email" },
            ]}
          >
            <Input placeholder="you@company.com" autoComplete="email" />
          </Form.Item>

          <Form.Item
            name="newPassword"
            label="New password"
            rules={[
              { required: true, message: "Please enter a new password" },
              { min: 8, message: "Password must be at least 8 characters." },
            ]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>

          <Form.Item className={styles.authSubmit}>
            <Button
              htmlType="submit"
              type="primary"
              block
              loading={resetMutation.isLoading}
            >
              Set new password
            </Button>
          </Form.Item>
        </Form>

        <button
          type="button"
          className={styles.forgotCancel}
          onClick={() => setForgotOpen(false)}
        >
          Back to sign in
        </button>
      </ModalComponent>
    </div>
  );
};

export default LoginPage;
