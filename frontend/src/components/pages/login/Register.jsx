import { App, Button, Col, Form, Input, Row } from "antd";

import styles from "@/styles/pages/Login.module.scss";
import { useRouter } from "next/navigation";
import session from "@/assets/onboarding/session-placeholder.svg";
import Image from "next/image";
import { useMutation, useQuery } from "react-query";
import { getRegistrationStatus, register } from "@/services/auth.service";
import VulnPenLogo from "@/components/common/VulnPenLogo";

import Link from "next/link";

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
    onSuccess: (data) => {
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



  return (
    <Row className={styles.loginContainer}>
      <Col xl={16} lg={12} md={12} xs={0} className={styles.leftContainer}>
        <div className={styles.loginBannerContainer}>
          <div className={styles.loginBannerText}>
            <h1>
              Point VulnPen at a web application and{" "}
              <span>let the testing start</span>
            </h1>

            <p>
              VulnPen plans its work from the OWASP WSTG v4.2 catalogue, runs
              each test case, records the evidence, maps every finding to the
              OWASP Top 10:2025 and drafts the penetration testing report.
            </p>
          </div>

          <div className={styles.loginBanner}>
            <Image src={session} alt="session" />
          </div>
        </div>
      </Col>
      <Col xl={8} lg={12} md={12} xs={24} className={styles.rightContainer}>
        <div
          className={styles.navbar}
          style={{
            display: "flex",
          }}
        >
          <VulnPenLogo plain />
        </div>
        <div className={styles.loginForm}>
          <h1>
            Sign up to <span>VulnPen</span>
          </h1>
          <p>AI assistant for web application security testing by T-NET IT Solution</p>


          <Row style={{ flexDirection: "column" }}>
            {registrationStatus?.registrationOpen === false && (
              <p>
                Registration is closed on this installation. Sign in with an
                existing account — an operator can reopen it with{" "}
                <code>ALLOW_REGISTRATION=true</code>.
              </p>
            )}
            {registrationStatus?.bootstrap === true && (
              <p>
                This is a new installation: the first account created becomes
                the installation owner.
              </p>
            )}
            <Form className={styles.formContent} onFinish={handleRegister}>
              <Form.Item
                name="name"
                rules={[
                  {
                    required: true,
                    message: "Please enter your name",
                  },
                ]}
              >
                <Input placeholder="Enter your name" />
              </Form.Item>
              <Form.Item
                name="email"
                rules={[
                  {
                    required: true,
                    message: "Please enter your email",
                  },
                  {
                    type: "email",
                    message: "Invalid email",
                  },
                ]}
              >
                <Input placeholder="Enter your email" />
              </Form.Item>
              <Form.Item
                name="password"
                rules={[
                  {
                    required: true,
                    message: "Please enter your password",
                  },
                  {
                    min: 8,
                    message: "Password must be at least 8 characters",
                  },

                ]}
              >
                <Input.Password placeholder="Enter your password" />
              </Form.Item>
              {/* <Form.Item
                name="terms"
                rules={[
                  {
                    required: true,
                    message: "Please accept the terms and conditions",
                  },
                ]}
              >
                <Checkbox value={true}>
                  <div className={styles.terms}>
                    I accept all the{" "}
                    <a target="_blank" href="/terms">
                      Terms & Conditions
                    </a>
                    .
                  </div>
                </Checkbox>
              </Form.Item> */}
              <Form.Item>
                <Button
                  className={styles.loginButtonBugbase}
                  htmlType="submit"
                  disabled={registrationStatus?.registrationOpen === false}
                  loading={registrationStatusLoading || registerMutation.isLoading}
                >
                  Register
                </Button>
              </Form.Item>
            </Form>


            <Link
              className={styles.docLink}
              href="/login"
            >
              <div className={styles.linkText}>Already a User? Login</div>
            </Link>
          </Row>
        </div>
      </Col>
    </Row>
  );
};

export default RegisterPage;
