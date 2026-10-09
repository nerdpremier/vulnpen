"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";

/**
 * A page's actions, carried up to the app header.
 *
 * The header is rendered by the session layout, so a page cannot pass a node
 * into it directly. Instead the page publishes what it wants shown and the
 * header renders it on its own line — which keeps the buttons at the top of the
 * window, on the same row as the engagement's breadcrumb, rather than in a band
 * of their own above the page body.
 *
 * Actions are a stable identity per page: the page mounts its actions and
 * clears them on unmount, so navigating between pages never leaves a stale
 * button behind.
 */
const HeaderActionsContext = createContext(null);

export function HeaderActionsProvider({ children }) {
  const [slot, setSlot] = useState(null);

  const value = useMemo(() => ({ slot, setSlot }), [slot]);

  return (
    <HeaderActionsContext.Provider value={value}>
      {children}
    </HeaderActionsContext.Provider>
  );
}

/** Read the actions a page has published. Used by the header itself. */
export function useHeaderActions() {
  return useContext(HeaderActionsContext);
}

/**
 * Publish this page's action buttons into the header.
 *
 * @param node  the buttons to render, or null to clear the slot
 */
export function usePublishHeaderActions(node) {
  const ctx = useContext(HeaderActionsContext);

  useEffect(() => {
    if (!ctx) return undefined;
    ctx.setSlot(node);
    return () => ctx.setSlot(null);
    // The node is rebuilt each render; keying the effect on the context setter
    // alone would miss changes, so it runs whenever the node's identity moves.
  }, [ctx, node]);

  return ctx;
}
