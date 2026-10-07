"use client";

import React, { use } from "react";
import DesktopPage from "@/components/pages/session/desktop/DesktopPage";

/**
 * The desktop route is a thin wrapper: the page owns its own data, states and
 * layout. It used to hold all of that inline and, on both of its failure
 * paths, push `/session/<id>/connection` — a route that has never existed.
 */
export default function DesktopRoute({ params }) {
  const { session_id: sessionId } = use(params);
  return <DesktopPage sessionId={sessionId} />;
}
