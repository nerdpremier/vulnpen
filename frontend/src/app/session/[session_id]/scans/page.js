"use client";

import React, { use } from "react";
import { Spin } from "antd";
import ScansPage from "@/components/pages/session/scans/ScansPage";

export default function ScansRoute({ params }) {
  const { session_id: sessionId } = use(params);
  if (!sessionId) return <Spin />;
  return <ScansPage sessionId={sessionId} />;
}
