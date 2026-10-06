"use client";

import { useEffect, useRef } from "react";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { getSessionHistory } from "@/services/agent.service";


export default function AgentStreamConnector({ sessionId }) {
  const store = useAgentStreamStore;
  const loadingRef = useRef(false);
  // Runs launched outside the chat (the case page) flag history stale in the
  // store; subscribing to the flag makes this connector refetch when that
  // happens, so the chat never shows a transcript missing those messages.
  const historyLoaded = useAgentStreamStore(
    (state) => state.sessions[sessionId]?.historyLoaded ?? false,
  );

  useEffect(() => {
    if (!sessionId) return;
    store.getState().getOrCreate(sessionId);
    if (historyLoaded || loadingRef.current) return;
    loadingRef.current = true;

    getSessionHistory(sessionId)
      .then((data) => {
        if (!data) return;
        const { loadHistory, setAgentState, setPendingConsent, setTokenUsage } =
          store.getState();
        if (data.messages) {
          loadHistory(sessionId, data.messages);
        }
        if (data.agentState) {
          setAgentState(sessionId, data.agentState);
        }
        if (data.pendingConsent) {
          setPendingConsent(sessionId, data.pendingConsent);
        }
        if (data.totalTokens != null) {
          setTokenUsage(sessionId, {
            totalTokens: data.totalTokens,
            contextLimit: data.contextLimit ?? 128_000,
            promptTokens: data.promptTokens ?? undefined,
            completionTokens: data.completionTokens ?? undefined,
          });
        }
      })
      .catch(() => {})
      .finally(() => {
        loadingRef.current = false;
      });
  }, [sessionId, store, historyLoaded]);

  useEffect(() => {
    const onContextCleared = (e) => {
      if (e.detail?.sessionId !== sessionId) return;
      const st = store.getState();
      const s = st.getSession(sessionId);
      if (s?.controllerRef?.current) {
        try {
          s.controllerRef.current.abort();
        } catch {
          /* ignore */
        }
        s.controllerRef.current = null;
      }
      st.setMessages(sessionId, []);
      st.setAgentState(sessionId, "idle");
      st.setPendingConsent(sessionId, null);
      st.setTokenUsage(sessionId, null);
    };
    window.addEventListener("context-cleared", onContextCleared);
    return () => window.removeEventListener("context-cleared", onContextCleared);
  }, [sessionId, store]);

  return null;
}
