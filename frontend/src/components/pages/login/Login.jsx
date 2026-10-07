import { App, Button, Form, Input } from "antd";

import styles from "@/styles/pages/Login.module.scss";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getRegistrationStatus, login } from "@/services/auth.service";
import Link from "next/link";
import { loginUser } from "@/store/user.slice";
import { useDispatch } from "react-redux";
import { AnimatedContent, MoonBackdrop, ShinyText } from "@/components/common/ui";

const LoginPage = () => {
  const router = useRouter();
  const dispatch = useDispatch();
  const queryClient = useQueryClient();
  const { message } = App.useApp();
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
    </div>
  );
};

export default LoginPage;
