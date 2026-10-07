"use client";

import React, { useEffect } from "react";
import { App, Button } from "antd";
import { checkSession } from "@/services/auth.service";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "react-query";
import { useDispatch } from "react-redux";
import { loginUser, logout } from "@/store/user.slice";
import MobileScreen from "./MobileScreen";
import Loader from "@/components/common/loader/Loader";
import { PageShell, PageState } from "@/components/common/ui";
import styles from "@/app/page.module.scss";

export const AuthContextProvider = ({ children }) => {
  const [loading, setLoading] = React.useState(true);
  const [unreachable, setUnreachable] = React.useState(null);
  const dispatch = useDispatch();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { notification } = App.useApp();

  const referral = searchParams.get("referral");

  useEffect(() => {
    if (referral) {
      localStorage.setItem("referral", referral);
    }
  }, [referral]);

  const sessionQuery = useQuery(["check-session"], checkSession, {
    retry: false,
    onSuccess: (data) => {
      // The backend could not be reached: that is not an expired session, so
      // nothing is dispatched and the user is offered a retry instead of a
      // sign-out that would not have helped.
      if (data?.unreachable) {
        setUnreachable(data.reason || "The API did not respond.");
        setLoading(false);
        return;
      }

      setUnreachable(null);

      if (data?.user) {
        dispatch(loginUser(data.user));
        if (
          pathname === "/" ||
          pathname === "/login" ||
          pathname === "/register" ||
          pathname === "/dashboard"
        ) {
          router.push("/dashboard");
        }
      } else if (
        pathname !== "/" &&
        !pathname.includes("/login") &&
        !pathname.includes("/register")
      ) {
        notification.error({
          message: "Session Expired or Invalid",
          description: "Please login again!",
        });
        dispatch(logout());
        router.replace("/login");
      }
      setLoading(false);
    },
  });

  if (loading) {
    return (
      <Loader
        message="Checking session"
        subtext="Verifying your credentials..."
      />
    );
  }

  if (unreachable) {
    return (
      <PageShell width="full">
        <PageState
          state="error"
          title="Can't reach the VulnPen API"
          description={`${unreachable} — your session is still valid; the server just did not answer. Check that the backend is running, then retry.`}
          onRetry={() => {
            setLoading(true);
            sessionQuery.refetch();
          }}
          retryLabel="Retry"
          actions={
            <Button type="text" onClick={() => window.location.reload()}>
              Reload the page
            </Button>
          }
        />
      </PageShell>
    );
  }

  // The auth pages render on any screen: /login linked to /register, but
  // /register still went through MobileScreen, so signing up on a phone
  // reached "use VulnPen on a larger screen".
  if (pathname === "/login" || pathname === "/register") {
    return <>{children}</>;
  }

  return (
    <>
      <div className={styles.pageWrapper}>{children}</div>
      <MobileScreen />
    </>
  );
};
