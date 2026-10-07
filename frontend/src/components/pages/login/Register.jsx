import { Alert, App, Button, Form, Input } from "antd";

import styles from "@/styles/pages/Login.module.scss";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "react-query";
import { getRegistrationStatus, register } from "@/services/auth.service";
import Link from "next/link";
import { AnimatedContent, MoonBackdrop, ShinyText } from "@/components/common/ui";

const RegisterPage = () => {
  const router = useRouter();
  const { message } = App.useApp();
  const { data: registrationStatus, isLoading: registrationStatusLoading } =
    useQuery("registration-status", getRegistrationStatus);

  const registerMutation = useMutation(register, {
    onError: (error) => {
      message.error(
        error?.response?.data?.message ??
          "Failed to register. Please try again later."
      );
    },
    onSuccess: () => {
      message.success("Registration successful. Please login to continue.");
      router.push("/login");
    },
  });

  const handleRegister = (values) => {
    registerMutation.mutate({
      name: values.name,
      email: values.email,
      password: values.password,
    });
  };

  const registrationClosed = registrationStatus?.registrationOpen === false;

  return (
    <div className={styles.authShell}>
      <MoonBackdrop variant="page" />

      <main className={styles.authPanel}>
        <AnimatedContent className={styles.authStack} direction="up">
          <div className={styles.authCard}>
            <span className={styles.authEyebrow}>Create account</span>
            <h1 className={styles.authTitle}>
              Sign up to{" "}
              <ShinyText text="VulnPen" className={styles.authWord} />
            </h1>
            <p className={styles.authSubtitle}>
              AI assistant for web application security testing.
            </p>

            {registrationClosed && (
              <Alert
                type="warning"
                showIcon
                className={styles.authNotice}
                message="Registration is closed on this installation"
                description={
                  <>
                    Sign in with an existing account, or ask an operator to
                    reopen it with <code>ALLOW_REGISTRATION=true</code>.
                  </>
                }
              />
            )}

            {registrationStatus?.bootstrap === true && !registrationClosed && (
              <Alert
                type="info"
                showIcon
                className={styles.authNotice}
                message="New installation"
                description="The first account created becomes the installation owner."
              />
            )}

            <Form
              className={styles.authForm}
              layout="vertical"
              onFinish={handleRegister}
              requiredMark={false}
            >
              <Form.Item
                name="name"
                label="Name"
                rules={[{ required: true, message: "Please enter your name" }]}
              >
                <Input placeholder="Your name" autoComplete="name" />
              </Form.Item>

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
                rules={[
                  { required: true, message: "Please enter your password" },
                  { min: 8, message: "Password must be at least 8 characters" },
                ]}
              >
                <Input.Password
                  placeholder="Choose a password"
                  autoComplete="new-password"
                />
              </Form.Item>

              <Form.Item className={styles.authSubmit}>
                <Button
                  htmlType="submit"
                  type="primary"
                  block
                  disabled={registrationClosed}
                  loading={
                    registrationStatusLoading || registerMutation.isLoading
                  }
                >
                  Create account
                </Button>
              </Form.Item>
            </Form>

            <Link className={styles.authLink} href="/login">
              Already have an account? Sign in
            </Link>
          </div>
        </AnimatedContent>
      </main>
    </div>
  );
};

export default RegisterPage;
