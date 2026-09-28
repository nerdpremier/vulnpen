import { redirect } from "next/navigation";

/**
 * VulnPen has no public marketing site. Unauthenticated visitors go to the
 * login screen; sessions that are already authenticated are redirected to the
 * dashboard by AuthContextProvider.
 */
export default function Home() {
  redirect("/login");
}