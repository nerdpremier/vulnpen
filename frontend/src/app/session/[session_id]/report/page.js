"use client";

import React, { use } from "react";
import { Spin } from "antd";
import ReportPage from "@/components/pages/session/websecurity/ReportPage";

export default function ReportRoute({ params }) {
  const { session_id: sessionId } = use(params);
  if (!sessionId) return <Spin />;
  return <ReportPage sessionId={sessionId} />;
}
