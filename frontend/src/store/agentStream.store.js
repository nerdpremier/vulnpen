import { createWithEqualityFn } from "zustand/traditional";
import { shallow } from "zustand/vanilla/shallow";

function createSessionState() {
  return {
    messages: [],
    agentState: "idle",
    pendingConsent: null,
    sidebarExpanded: true,
    historyLoaded: false,
    // A failed transcript load is a state, not an empty session: without this
    // the chat showed "What do you want to secure today?" over a transcript it
    // had never managed to read.
    historyError: null,
    historyRetry: 0,
    tokenUsage: null,

    controllerRef: { current: null },
    streamingAssistantRef: { current: null },
    toolOutputBufferRef: { current: {} },
    toolOutputRafRef: { current: null },
    thinkingBufferRef: { current: null },
    thinkingFlushTimerRef: { current: null },
    lastThinkingFlushRef: { current: 0 },
    reasoningBufferRef: { current: null },
    reasoningRafRef: { current: null },
    slashStreamRef: { current: null },
    toolNameMapRef: { current: {} },
  };
}

export const useAgentStreamStore = createWithEqualityFn((set, get) => ({
  sessions: {},

  getOrCreate: (sessionId) => {
    const sessions = get().sessions;
    if (sessions[sessionId]) return sessions[sessionId];
    const s = createSessionState();
    set({ sessions: { ...sessions, [sessionId]: s } });
    return s;
  },

  getSession: (sessionId) => {
    return get().sessions[sessionId] || null;
  },

  setMessages: (sessionId, messagesOrUpdater) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const newMessages =
        typeof messagesOrUpdater === "function"
          ? messagesOrUpdater(s.messages)
          : messagesOrUpdater;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, messages: newMessages },
        },
      };
    });
  },

  setAgentState: (sessionId, agentState) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      if (typeof agentState === "function") {
        agentState = agentState(s.agentState);
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, agentState },
        },
      };
    });
  },

  setPendingConsent: (sessionId, pendingConsent) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, pendingConsent },
        },
      };
    });
  },

  setSidebarExpanded: (sessionId, expanded) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, sidebarExpanded: expanded },
        },
      };
    });
  },

  setTokenUsage: (sessionId, tokenUsage) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, tokenUsage },
        },
      };
    });
  },

  setHistoryLoaded: (sessionId, loaded) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, historyLoaded: loaded },
        },
      };
    });
  },

  /**
   * A run launched outside the chat (the case page's Nessus-style runs)
   * appends messages on the server; drop the loaded flag so the chat page
   * refetches history instead of showing a stale transcript.
   */
  markHistoryStale: (sessionId) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s || !s.historyLoaded) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, historyLoaded: false },
        },
      };
    });
  },

  /** Record (or clear) why the transcript could not be read. */
  setHistoryError: (sessionId, historyError) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, historyError },
        },
      };
    });
  },

  /**
   * Ask for the transcript again after a failed read. The session's
   * `historyRetry` counter is what the connector watches — `historyLoaded` is
   * already false in the failure case, so flipping it would change nothing.
   */
  retryHistory: (sessionId) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...s,
            historyError: null,
            historyRetry: (s.historyRetry ?? 0) + 1,
          },
        },
      };
    });
  },

  loadHistory: (sessionId, historyMessages) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...s,
            messages: historyMessages.map((m) => ({ ...m, streaming: false })),
            historyLoaded: true,
            historyError: null,
          },
        },
      };
    });
  },

  clearSession: (sessionId) => {
    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      if (s.controllerRef.current) {
        s.controllerRef.current.abort();
        s.controllerRef.current = null;
      }
      const { [sessionId]: _, ...rest } = state.sessions;
      return { sessions: rest };
    });
  },
}), shallow);
