"use client";

import React, { use } from "react";
import { Spin } from "antd";
import TestPlanPage from "@/components/pages/session/websecurity/TestPlanPage";

export default function TestPlanRoute({ params }) {
  const { session_id: sessionId } = use(params);
  if (!sessionId) return <Spin />;
  return <TestPlanPage sessionId={sessionId} />;
}