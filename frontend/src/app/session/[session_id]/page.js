"use client";

import React, { use } from "react";
import EngagementOverviewPage from "@/components/pages/session/overview/EngagementOverviewPage";

/**
 * The engagement's home. Chat moved to `/session/<id>/chat`; a session used to
 * open straight into an empty composer, which says nothing about the state of
 * the work.
 */
export default function SessionOverviewRoute({ params }) {
  const { session_id: sessionId } = use(params);
  return <EngagementOverviewPage sessionId={sessionId} />;
}
