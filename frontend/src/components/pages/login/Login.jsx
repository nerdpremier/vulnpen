import { App, Button, Form, Input } from "antd";

import styles from "@/styles/pages/Login.module.scss";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "react-query";
import { getRegistrationStatus, login } from "@/services/auth.service";
import Link from "next/link";
import { loginUser } from "@/store/user.slice";
import { useDispatch } from "react-redux";
import { MoonBackdrop, ShinyText } from "@/components/common/ui";

const CAPABILITIES = [
  "97 WSTG v4.2 test cases across 12 categories",
  "Evidence recorded per case; findings mapped to the OWASP Top 10:2025",
  "Report draft generated from the evidence the session already holds",
];

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

      <aside className={styles.authBrand}>
        <div className={styles.brandTop}>
          <div className={styles.brandText}>
            <span className={styles.brandName}>VulnPen</span>
            <span className={styles.brandSub}>T-NET IT Solution</span>
          </div>
        </div>

        <div className={styles.brandBody}>
          <h2 className={styles.brandHeadline}>
            Point VulnPen at a web application and{" "}
            <ShinyText text="let the testing start" speed={7} />
          </h2>
          <p className={styles.brandCopy}>
            VulnPen plans its work from the OWASP WSTG v4.2 catalogue, runs each
            test case, records the evidence, maps every finding to the OWASP Top
            10:2025 and drafts the penetration testing report.
          </p>
          <ul className={styles.brandList}>
            {CAPABILITIES.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>

        <div className={styles.brandFoot}>
          <span className={styles.brandFootDot} />
          Authorised testing only
        </div>
      </aside>

      <main className={styles.authPanel}>
        <div className={styles.authCard}>
          <span className={styles.authEyebrow}>Sign in</span>
          <h1 className={styles.authTitle}>Welcome back</h1>
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

          {registrationStatus?.registrationOpen && (
            <Link className={styles.authLink} href="/register">
              New here? Create an account
            </Link>
          )}
        </div>

        <p className={styles.authFootnote}>
          For authorised security testing only. You are responsible for having
          permission to test every target you point VulnPen at.
        </p>
      </main>
    </div>
  );
};

export default LoginPage;
