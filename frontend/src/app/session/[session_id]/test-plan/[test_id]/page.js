"use client";

import React, { use } from "react";
import { Spin } from "antd";
import TestCaseDetailPage from "@/components/pages/session/websecurity/TestCaseDetailPage";

export default function TestCaseDetailRoute({ params }) {
  const { session_id: sessionId, test_id: testId } = use(params);
  if (!sessionId || !testId) return <Spin />;
  return <TestCaseDetailPage sessionId={sessionId} testId={testId} />;
}
