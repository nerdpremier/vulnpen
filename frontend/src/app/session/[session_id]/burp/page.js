"use client";

import React, { use } from "react";
import BurpProxyPage from "@/components/pages/session/burp/BurpProxyPage";

/**
 * Burp as a full page, reached from the engagement rail — the same component
 * the chat's right-hand rail mounts. The route used to mutate the session list
 * during render; the page owns no global state now.
 */
export default function BurpRoute({ params }) {
  const { session_id: sessionId } = use(params);
  // `asPage` gives the panel a page header and page padding; the rail's inline
  // mount of the same component keeps its compact pane toolbar.
  return <BurpProxyPage sessionId={sessionId} asPage />;
}
