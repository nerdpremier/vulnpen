"use client";

import React, { use } from "react";
import { Spin } from "antd";
import ScanDetailPage from "@/components/pages/session/scans/ScanDetailPage";

export default function ScanDetailRoute({ params }) {
  const { session_id: sessionId, run_id: runId } = use(params);
  if (!sessionId || !runId) return <Spin />;
  return <ScanDetailPage sessionId={sessionId} runId={runId} />;
}
