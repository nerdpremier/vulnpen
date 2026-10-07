"use client";

import React, { use } from "react";
import SessionMainPage from "@/components/pages/session/sessionId/SessionMainPage";

/** The agent chat, at its own address now that the session root is the overview. */
export default function ChatRoute({ params }) {
  const { session_id: sessionId } = use(params);
  if (!sessionId) return null;
  return <SessionMainPage session_id={sessionId} />;
}
