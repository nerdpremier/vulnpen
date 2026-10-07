"use client";

import { AuthContextProvider } from "@/components/common/auth/AuthContext";

/**
 * The `/session` branch only wraps its children in auth context.
 *
 * It used to guard `pathname === "/session"` with `router.replace("/dashboard")`
 * during render — a navigation side effect in a render body, guarding a route
 * that does not exist (`app/session/page.js` was never created), so it could
 * never fire.
 */
const SessionLayout = ({ children }) => (
  <AuthContextProvider>{children}</AuthContextProvider>
);

export default SessionLayout;
