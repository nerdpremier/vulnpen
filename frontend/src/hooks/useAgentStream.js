import { useCallback, useEffect, useMemo } from "react";
import { connectAgentStream } from "@/services/agent.service";
import { v4 as uuidv4 } from "uuid";
import { useAgentStreamStore } from "@/store/agentStream.store";
import { useShallow } from "zustand/react/shallow";
import { notification } from "antd";
import { finalizeAbortedToolCalls } from "@/utils/finalizeAbortedToolCalls.mjs";
import { isBrowserTool } from "@/utils/toolCatalog";

const EMPTY_MESSAGES = [];

// Cap live tool output held in client state. A chatty scan streams far more
// stdout than the UI ever shows (the block renders the tail only), and keeping
// every byte makes each later render - and the GC - pay for invisible text.
const MAX_LIVE_TOOL_CHARS = 60_000;

// ReactMarkdown re-parses the whole assistant document on every render, so
// coalesce streaming content updates into at most one update per interval.
const THINKING_FLUSH_INTERVAL_MS = 90;

const DEFAULT_STATE = {
  messages: EMPTY_MESSAGES,
  agentState: "idle",
  pendingConsent: null,
  tokenUsage: null,
};

export default function useAgentStream({
  sessionId,
  onComplete,
  onInstallSuggestion,
  onIterationLimit,
}) {
  const store = useAgentStreamStore;

  useEffect(() => {
    store.getState().getOrCreate(sessionId);
  }, [sessionId, store]);

  const { messages, agentState, pendingConsent, tokenUsage } =
    useAgentStreamStore(
      useShallow((state) => {
        const s = state.sessions[sessionId];
        if (!s) return DEFAULT_STATE;
        return {
          messages: s.messages ?? EMPTY_MESSAGES,
          agentState: s.agentState ?? "idle",
          pendingConsent: s.pendingConsent ?? null,
          tokenUsage: s.tokenUsage ?? null,
        };
      }),
    );

  const refs = useCallback(() => {
    const s = store.getState().getSession(sessionId);
    return s || store.getState().getOrCreate(sessionId);
  }, [sessionId, store]);

  const setMessages = useCallback(
    (updater) => store.getState().setMessages(sessionId, updater),
    [sessionId, store],
  );

  const setAgentState = useCallback(
    (val) => store.getState().setAgentState(sessionId, val),
    [sessionId, store],
  );

  const setPendingConsent = useCallback(
    (val) => store.getState().setPendingConsent(sessionId, val),
    [sessionId, store],
  );

  const setTokenUsage = useCallback(
    (val) => store.getState().setTokenUsage(sessionId, val),
    [sessionId, store],
  );

  const flushToolOutputBuffer = useCallback(() => {
    const r = refs();
    const buffer = r.toolOutputBufferRef.current;
    r.toolOutputRafRef.current = null;
    if (Object.keys(buffer).length === 0) return;

    // One pass over the message list no matter how many tools streamed in
    // parallel, instead of a full map per tool id.
    setMessages((prev) => {
      let changed = false;
      const next = prev.map((m) => {
        const chunk = buffer[m.id];
        if (!chunk) return m;
        changed = true;
        const combined = m.content + chunk;
        return {
          ...m,
          content:
            combined.length > MAX_LIVE_TOOL_CHARS
              ? "[... earlier output trimmed ...]\n" + combined.slice(-MAX_LIVE_TOOL_CHARS)
              : combined,
        };
      });
      return changed ? next : prev;
    });
    r.toolOutputBufferRef.current = {};
  }, [refs, setMessages]);

  const flushReasoningBuffer = useCallback(() => {
    const r = refs();
    const ref = r.streamingAssistantRef.current;
    if (!ref || r.reasoningBufferRef.current === null) return;
    setMessages((prev) =>
      prev.map((m) => (m.id === ref.id ? { ...m, reasoning: ref.reasoning } : m)),
    );
    r.reasoningBufferRef.current = null;
    r.reasoningRafRef.current = null;
  }, [refs, setMessages]);

  const flushThinkingBuffer = useCallback(() => {
    const r = refs();
    const ref = r.streamingAssistantRef.current;
    r.thinkingFlushTimerRef.current = null;
    if (!ref || r.thinkingBufferRef.current === null) return;
    r.lastThinkingFlushRef.current = Date.now();
    setMessages((prev) =>
      prev.map((m) => (m.id === ref.id ? { ...m, content: ref.content } : m)),
    );
    r.thinkingBufferRef.current = null;
  }, [refs, setMessages]);

  // Throttled rather than per-animation-frame: every flush re-parses the whole
  // markdown document, which is what made long replies feel stuck.
  const scheduleThinkingFlush = useCallback(() => {
    const r = refs();
    if (r.thinkingFlushTimerRef.current) return;
    const elapsed = Date.now() - r.lastThinkingFlushRef.current;
    r.thinkingFlushTimerRef.current = setTimeout(
      flushThinkingBuffer,
      Math.max(0, THINKING_FLUSH_INTERVAL_MS - elapsed),
    );
  }, [refs, flushThinkingBuffer]);

  const flushAssistant = useCallback(() => {
    const r = refs();
    const ref = r.streamingAssistantRef.current;
    if (!ref) return;

    if (r.thinkingFlushTimerRef.current) {
      clearTimeout(r.thinkingFlushTimerRef.current);
      r.thinkingFlushTimerRef.current = null;
      r.thinkingBufferRef.current = null;
    }
    if (r.reasoningRafRef.current) {
      cancelAnimationFrame(r.reasoningRafRef.current);
      r.reasoningRafRef.current = null;
      r.reasoningBufferRef.current = null;
    }

    setMessages((prev) => {
      const existing = prev.find((m) => m.id === ref.id);
      if (existing) {
        return prev.map((m) =>
          m.id === ref.id
            ? { ...m, content: ref.content, reasoning: ref.reasoning || undefined, toolCalls: [...ref.toolCalls], streaming: false, reasoningStreaming: false }
            : m,
        );
      }
      return prev;
    });
    r.streamingAssistantRef.current = null;
  }, [refs, setMessages]);

  const startStream = useCallback(
    async ({ message, endpoint = "message", burpMeta = null }) => {
      setAgentState("running");

      let stream;
      try {
        stream = await connectAgentStream({ sessionId, message, endpoint });
      } catch (err) {
        const errMsg = err?.message ?? "Unknown error";
        notification.error({
          message: "Connection Failed",
          description: `Failed to connect to agent: ${errMsg}`,
          duration: 6,
          placement: "bottomRight",
        });
        setMessages((prev) => [
          ...prev,
          {
            id: `error_${Date.now()}`,
            role: "system",
            content: `Failed to connect to agent: ${errMsg}`,
            isError: true,
            timestamp: new Date(),
          },
        ]);
        setAgentState("idle");
        return;
      }

      const r = refs();
      r.controllerRef.current = stream;

      stream
        .onEvent("user_message_ack", (data) => {
          setMessages((prev) => [
            ...prev,
            { id: data.id, role: "user", content: message, timestamp: new Date(), ...(burpMeta ? { burpMeta } : {}) },
          ]);
        })
        .onEvent("reasoning", (data) => {
          const r2 = refs();
          if (!r2.streamingAssistantRef.current) {
            const id = uuidv4();
            r2.streamingAssistantRef.current = { id, content: "", reasoning: "", toolCalls: [] };
            setMessages((prev) => [
              ...prev,
              { id, role: "assistant", content: "", reasoning: "", toolCalls: [], streaming: true, reasoningStreaming: true },
            ]);
          }
          r2.streamingAssistantRef.current.reasoning += data.content;
          r2.reasoningBufferRef.current = true;
          if (!r2.reasoningRafRef.current) {
            r2.reasoningRafRef.current = requestAnimationFrame(flushReasoningBuffer);
          }
        })
        .onEvent("thinking", (data) => {
          const r2 = refs();
          if (!r2.streamingAssistantRef.current) {
            const id = uuidv4();
            r2.streamingAssistantRef.current = { id, content: "", reasoning: "", toolCalls: [] };
            setMessages((prev) => [
              ...prev,
              { id, role: "assistant", content: "", toolCalls: [], streaming: true },
            ]);
          }
          if (r2.streamingAssistantRef.current.reasoning) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === r2.streamingAssistantRef.current.id ? { ...m, reasoningStreaming: false } : m,
              ),
            );
          }
          r2.streamingAssistantRef.current.content += data.content;
          r2.thinkingBufferRef.current = true;
          scheduleThinkingFlush();
        })
        .onEvent("tool_call_start", (data) => {
          refs().toolCallAccRef.current[data.index] = {
            id: data.id,
            name: data.name,
            arguments: "",
          };
        })
        .onEvent("tool_call_args", (data) => {
          const r2 = refs();
          if (r2.toolCallAccRef.current[data.index]) {
            r2.toolCallAccRef.current[data.index].arguments += data.content;
          }
        })
        .onEvent("tool_call_ready", (data) => {
          const r2 = refs();
          const tc = {
            id: data.id,
            name: data.name,
            arguments: data.arguments,
          };
          if (r2.streamingAssistantRef.current) {
            r2.streamingAssistantRef.current.toolCalls.push(tc);
            const ref = r2.streamingAssistantRef.current;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === ref.id ? { ...m, toolCalls: [...ref.toolCalls] } : m,
              ),
            );
          }
          r2.toolCallAccRef.current = {};
        })
        .onEvent("tool_start", (data) => {
          flushAssistant();
          const r2 = refs();
          r2.toolNameMapRef.current[data.id] = data.name;

          setMessages((prev) => [
            ...prev,
            {
              id: `tool_${data.id}`,
              role: "tool",
              toolCallId: data.id,
              toolName: data.name,
              args: data.args,
              content: "",
              streaming: true,
              timestamp: new Date(),
            },
          ]);
        })
        .onEvent("tool_output", (data) => {
          const r2 = refs();
          const key = `tool_${data.id}`;
          r2.toolOutputBufferRef.current[key] =
            (r2.toolOutputBufferRef.current[key] ?? "") + data.chunk;
          if (!r2.toolOutputRafRef.current) {
            r2.toolOutputRafRef.current = requestAnimationFrame(flushToolOutputBuffer);
          }
        })
        .onEvent("tool_done", (data) => {
          const r2 = refs();
          if (r2.toolOutputRafRef.current) {
            cancelAnimationFrame(r2.toolOutputRafRef.current);
            flushToolOutputBuffer();
          }

          const toolName = r2.toolNameMapRef.current[data.id];
          if (isBrowserTool(toolName)) {
            delete r2.toolNameMapRef.current[data.id];
          }

          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== `tool_${data.id}`) return m;
              const useServerOutput = data.output && (!m.content || m.content.length === 0);
              return {
                ...m,
                content: useServerOutput ? data.output : m.content,
                streaming: false,
                exitCode: data.exitCode,
                files: data.files ?? m.files,
              };
            }),
          );
        })
        .onEvent("tool_error", (data) => {
          const r2 = refs();
          if (r2.toolOutputRafRef.current) {
            cancelAnimationFrame(r2.toolOutputRafRef.current);
            r2.toolOutputBufferRef.current = {};
            r2.toolOutputRafRef.current = null;
          }

          const toolName = r2.toolNameMapRef.current[data.id];
          if (isBrowserTool(toolName)) {
            delete r2.toolNameMapRef.current[data.id];
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === `tool_${data.id}`
                ? { ...m, content: data.error, streaming: false, exitCode: 1 }
                : m,
            ),
          );
        })
        .onEvent("consent_required", (data) => {
          flushAssistant();
          setPendingConsent({
            toolCallId: data.id,
            toolName: data.name,
            args: data.args,
            safetyBlock: data.safetyBlock ?? false,
            approvalReason: data.approvalReason,
            safetyReason: data.safetyReason,
            safetyImpact: data.safetyImpact,
            safetyKind: data.safetyKind,
            batch: data.batch,
          });
          setAgentState("waiting_consent");
        })
        .onEvent("install_suggestion", (data) => {
          onInstallSuggestion?.(data);
        })
        .onEvent("iteration_limit", (data) => {
          flushAssistant();
          onIterationLimit?.(data);
        })
        .onEvent("slash_command_ack", (data) => {
          setMessages((prev) => [
            ...prev,
            {
              id: `slash_ack_${Date.now()}`,
              role: "system",
              content: data.message,
              isSlashCommand: true,
              timestamp: new Date(),
            },
          ]);
        })
        .onEvent("slash_command_result", (data) => {
          if (data.action === "clear_messages") {
            setMessages([]);
          }
          if (data.action === "reset_state") {
            setAgentState("idle");
          }
          const id = data.id || `slash_result_${Date.now()}`;
          const r2 = refs();
          if (data.streaming) {
            r2.slashStreamRef.current = { id, content: data.content || "" };
          }
          setMessages((prev) => [
            ...prev,
            {
              id,
              role: "slash_command_result",
              command: data.command,
              content: data.content,
              success: data.success,
              streaming: !!data.streaming,
              timestamp: new Date(),
            },
          ]);
        })
        .onEvent("slash_command_stream", (data) => {
          const r2 = refs();
          const ref = r2.slashStreamRef.current;
          if (ref && ref.id === data.id) {
            ref.content += data.content;
            const snapshot = ref.content;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === data.id ? { ...m, content: snapshot } : m,
              ),
            );
          }
        })
        .onEvent("slash_command_done", (data) => {
          const r2 = refs();
          const finalContent = r2.slashStreamRef.current?.content || data.content;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === data.id
                ? { ...m, content: finalContent, streaming: false }
                : m,
            ),
          );
          r2.slashStreamRef.current = null;
        })
        .onEvent("summarizing", (data) => {
          setMessages((prev) => [
            ...prev,
            {
              id: `summarize_${Date.now()}`,
              role: "system",
              content: data.message,
              isSummary: true,
              timestamp: new Date(),
            },
          ]);
        })
        .onEvent("token_usage", (data) => {
          setTokenUsage({
            totalTokens: data.totalTokens,
            promptTokens: data.promptTokens,
            completionTokens: data.completionTokens,
            contextLimit: data.contextLimit,
            iteration: data.iteration,
            maxIterations: data.maxIterations,
          });
        })
        .onEvent("summary_done", () => {})
        .onEvent("paused", () => {
          flushAssistant();
          setAgentState("paused");
        })
        .onEvent("error", (data) => {
          flushAssistant();
          notification.error({
            message: "Agent Error",
            description: data.message?.length > 200 ? data.message.slice(0, 200) + "…" : data.message,
            duration: 6,
            placement: "bottomRight",
          });
          setMessages((prev) => [
            ...prev,
            {
              id: `error_${Date.now()}`,
              role: "system",
              content: `Error: ${data.message}`,
              isError: true,
              timestamp: new Date(),
            },
          ]);
        })
        .onEvent("done", () => {
          flushAssistant();
          setAgentState("idle");
          onComplete?.();
        })
        .onEvent("_stream_end", () => {
          flushAssistant();
          setAgentState((prev) => {
            if (prev === "running") return "idle";
            return prev;
          });
          // Only clear if a newer stream has not already taken the slot.
          if (refs().controllerRef.current === stream) {
            refs().controllerRef.current = null;
          }
        });
    },
    [sessionId, refs, setMessages, setAgentState, setPendingConsent, setTokenUsage, flushAssistant, flushToolOutputBuffer, scheduleThinkingFlush, flushReasoningBuffer, onComplete, onInstallSuggestion, onIterationLimit],
  );

  // Stopping has to be more than tearing down the fetch. Tool messages that
  // were streaming when Stop fired never receive tool_done / tool_error, so
  // they would stay `streaming: true` forever - and ToolCallBlock reads that
  // flag to decide whether to broadcast `browser-agent-idle`, which is what
  // folds the Browser Agent panel. Without this the panel stayed unfolded
  // after Stop until the page was reloaded.
  const abort = useCallback(() => {
    const r = refs();
    if (r.toolOutputRafRef.current) {
      cancelAnimationFrame(r.toolOutputRafRef.current);
      r.toolOutputRafRef.current = null;
    }
    // Land buffered output first, so the marker is appended after it rather
    // than being mixed into text that arrives after the run was stopped.
    flushToolOutputBuffer();
    r.controllerRef.current?.abort();
    flushAssistant();
    setMessages((prev) => finalizeAbortedToolCalls(prev));
    setAgentState("idle");
  }, [refs, flushToolOutputBuffer, flushAssistant, setMessages, setAgentState]);

  const loadHistory = useCallback(
    (historyMessages) => {
      store.getState().loadHistory(sessionId, historyMessages);
    },
    [sessionId, store],
  );

  return {
    messages,
    setMessages,
    agentState,
    setAgentState,
    pendingConsent,
    setPendingConsent,
    tokenUsage,
    setTokenUsage,
    startStream,
    abort,
    loadHistory,
  };
}
