"use client";

import React, { useEffect } from "react";
import { App } from "antd";
import { checkSession } from "@/services/auth.service";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "react-query";
import { useDispatch } from "react-redux";
import { loginUser, logout } from "@/store/user.slice";
import MobileScreen from "./MobileScreen";
import Loader from "@/components/common/loader/Loader";
import styles from "@/app/page.module.scss";

export const AuthContextProvider = ({ children }) => {
  const [loading, setLoading] = React.useState(true);
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

  useQuery(["check-session"], checkSession, {
    onSuccess: (data) => {
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
        // No valid session — same handling the onError branch used to do.
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

  return (
    <>
      {loading ? (
        <Loader
          message="Checking session"
          subtext="Verifying your credentials..."
        />
      ) : pathname === "/login" ? (
        <>{children}</>
      ) : (
        <>
          <div className={styles.pageWrapper}>{children}</div>
          <MobileScreen />
        </>
      )}
    </>
  );
};
