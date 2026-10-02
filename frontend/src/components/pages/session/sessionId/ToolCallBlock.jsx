import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import styles from "@/styles/components/Chat.module.scss";
import { apiBaseURL } from "@/utils/axios.config";
import {
  CaretRightOutlined,
  LoadingOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";

const TOOL_LABELS = {
  run_bash: "Bash",
  run_python_script: "Python Script",
  run_install_tool: "Install Tool",
  ask_user: "Question",
  spawn_shell: "Spawn Shell",
  write_to_shell: "Write to Shell",
  read_shell: "Read Shell",
  list_shells: "List Shells",
  close_shell: "Close Shell",
  view_image: "View Image",
  send_to_burp: "Burp Request",
  send_to_burp_repeater: "Burp Repeater",
  send_to_burp_intruder: "Burp Intruder",
  search_burp_proxy_history: "Burp Proxy History",
  burp_collaborator: "Burp Collaborator",
  browser_action: "Browser Action",
  magnitude_browser: "Browser Agent",
  update_engagement_state: "Engagement State",
  wstg_test_plan: "WSTG Test Plan",
  map_finding_owasp: "OWASP Mapping",
  generate_pentest_report: "Pentest Report",
};

function parseArgs(args) {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }
  return args;
}

function formatArgsPreview(toolName, parsed) {
  if (toolName === "run_bash") return parsed.command ?? "";
  if (toolName === "run_python_script")
    return parsed.file_name ?? "inline script";
  if (toolName === "run_install_tool") return parsed.tool_name ?? "";
  if (toolName === "ask_user") return parsed.question ?? "";
  if (toolName === "spawn_shell") return parsed.label ?? "";
  if (toolName === "write_to_shell")
    return `[${parsed.shell_id}] ${(parsed.input ?? "").slice(0, 60)}`;
  if (toolName === "read_shell") return `[${parsed.shell_id}]`;
  if (toolName === "close_shell") return `[${parsed.shell_id}]`;
  if (toolName === "view_image") return parsed.image_path ?? "";
  if (toolName === "send_to_burp_repeater" || toolName === "send_to_burp_intruder") {
    const req = parsed.raw_request ?? "";
    const firstLine = req.split(/\r?\n/)[0] || "";
    return parsed.host ?? firstLine.split(" ")[1] ?? "";
  }
  if (toolName === "search_burp_proxy_history")
    return `${parsed.query ?? ""} ${parsed.host ?? ""}`.trim();
  if (toolName === "burp_collaborator") return parsed.action ?? "";
  if (toolName === "browser_action")
    return `${parsed.url ?? ""} ${(parsed.goal ?? "").slice(0, 60)}`.trim();
  if (toolName === "magnitude_browser")
    return `${parsed.url ?? ""} ${(parsed.task ?? parsed.goal ?? "").slice(0, 50)}`.trim();
  if (toolName === "update_engagement_state")
    return `${parsed.action ?? ""} ${parsed.title ?? parsed.host ?? parsed.port ?? ""}`.trim();
  if (toolName === "send_to_burp") {
    const req = parsed.raw_request ?? "";
    const firstLine = req.split(/\r?\n/)[0] || "";
    const method = firstLine.split(" ")[0] || "";
    const path = firstLine.split(" ")[1] || "";
    return `${method} ${parsed.host ?? ""}${path ? `:${parsed.port ?? 443}${path}` : ""}`;
  }
  if (toolName === "wstg_test_plan")
    return `${parsed.action ?? ""} ${parsed.test_id ?? parsed.depth ?? parsed.target ?? ""}`.trim();
  if (toolName === "map_finding_owasp")
    return `${parsed.vulnerability_id ?? parsed.title ?? parsed.wstg_id ?? ""}`.trim();
  if (toolName === "generate_pentest_report")
    return `${parsed.path ?? parsed.target ?? "draft report"}`.trim();
  return JSON.stringify(parsed);
}

function getCodePreview(toolName, parsed) {
  if (toolName === "run_bash") {
    return { code: parsed.command ?? "", language: "bash" };
  }
  if (toolName === "run_install_tool") {
    return null;
  }
  if (toolName === "run_python_script") {
    return { code: parsed.script ?? "", language: "python" };
  }
  if (toolName === "send_to_burp") {
    return { code: parsed.raw_request ?? "", language: "http" };
  }
  if (toolName === "shell_exec") {
    return { code: parsed.command ?? "", language: "bash" };
  }
  return null;
}

// Above this size an output block starts folded: long scan logs are rarely
// read inline and cost the most to lay out.
const LONG_OUTPUT_COLLAPSE_AT = 4000;
const OUTPUT_WINDOW = 12_000;

const highlighterCustomStyle = {
  margin: 0,
  borderRadius: "0",
  fontSize: "0.78rem",
  background: "transparent",
  padding: "0.6rem 0.75rem",
};

const ToolCallBlock = React.memo(function ToolCallBlock({ message, sessionId }) {
  // Show only the output by default — the command stays folded behind the
  // header until clicked, like the reasoning block.
  const [codeCollapsed, setCodeCollapsed] = useState(true);
  const [outputCollapsed, setOutputCollapsed] = useState(
    () => (message.content?.length ?? 0) > LONG_OUTPUT_COLLAPSE_AT,
  );
  const [copied, setCopied] = useState(false);
  const outputRef = useRef(null);

  const { toolName, args, content, streaming, exitCode, files } = message;

  const label = TOOL_LABELS[toolName] ?? toolName;
  const parsed = useMemo(() => parseArgs(args), [args]);
  const argsPreview = formatArgsPreview(toolName, parsed);
  const codePreview = useMemo(
    () => getCodePreview(toolName, parsed),
    [toolName, parsed],
  );

  const isRunning = streaming;
  const isError = exitCode != null && exitCode !== 0;
  const isSuccess = exitCode != null && exitCode === 0;
  const hasContent = content && content.length > 0;
  const hasCode = codePreview && codePreview.code;

  useEffect(() => {
    if (streaming && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [content, streaming]);

  // The Browser Agent live panel listens for this and unfolds itself so the
  // user sees the automation as it happens.
  useEffect(() => {
    if (streaming && /browser/i.test(toolName)) {
      window.dispatchEvent(new CustomEvent("browser-agent-active"));
    }
  }, [toolName, streaming]);

  const copyText = useCallback((text) => {
    if (navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text);
    }
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      return Promise.resolve();
    } finally {
      document.body.removeChild(textarea);
    }
  }, []);

  const handleCopy = useCallback(
    (e) => {
      e.stopPropagation();
      const textToCopy = hasCode ? codePreview.code : argsPreview;
      if (!textToCopy) return;
      copyText(textToCopy)
        .then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
        .catch(() => {});
    },
    [argsPreview, hasCode, codePreview, copyText],
  );

  const trimmed = hasContent && content.length > OUTPUT_WINDOW;
  const cleanedContent = hasContent
    ? content
        // eslint-disable-next-line no-control-regex
        .replace(/\x1B\[[0-?]*[-[\]#-~]|\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[@-_]|\r(?!\n)/g, "")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
    : content;
  const outputLines = hasContent ? cleanedContent.split("\n").length : 0;
  const displayContent = hasContent
    ? trimmed
      ? "[... earlier output trimmed ...]\n" + cleanedContent.slice(-OUTPUT_WINDOW)
      : cleanedContent
    : null;

  return (
    <div className={styles.toolCallBlock}>
      <div
        className={styles.toolCallHeader}
        onClick={() => {
          if (hasCode) setCodeCollapsed(!codeCollapsed);
          else if (hasContent) setOutputCollapsed(!outputCollapsed);
        }}
      >
        {(hasContent || hasCode) && (
          <span
            className={`${styles.toolCallIcon} ${(hasCode ? !codeCollapsed : !outputCollapsed) ? styles.toolCallIconOpen : ""}`}
          >
            <CaretRightOutlined />
          </span>
        )}
        <span className={styles.toolCallName}>{label}</span>
        <span className={styles.toolCallArgs} title={argsPreview}>
          {argsPreview}
        </span>
        {(argsPreview || hasCode) && (
          <button
            className={`${styles.toolCallCopyBtn} ${copied ? styles.copied : ""}`}
            onClick={handleCopy}
            title={copied ? "Copied!" : "Copy code"}
          >
            {copied ? <CheckOutlined /> : <CopyOutlined />}
          </button>
        )}
        <span
          className={`${styles.toolCallStatus} ${
            isRunning
              ? styles.toolCallRunning
              : isError
                ? styles.toolCallError
                : isSuccess
                  ? styles.toolCallSuccess
                  : ""
          }`}
        >
          {isRunning ? (
            <>
              <LoadingOutlined spin /> Running
            </>
          ) : isError ? (
            `Exit ${exitCode}`
          ) : isSuccess ? (
            "Done"
          ) : (
            ""
          )}
        </span>
      </div>

      {files?.length > 0 && sessionId && (
        <div className={styles.toolCallImages}>
          {files
            .filter((name) => /\.(png|jpe?g|gif|webp)$/i.test(name))
            .map((name) => {
              const fileUrl = `${apiBaseURL}/agent/session/${sessionId}/files/${encodeURIComponent(name)}`;
              return (
                <a key={name} href={fileUrl} target="_blank" rel="noreferrer">
                  <img
                    src={fileUrl}
                    alt={name}
                    className={styles.toolCallImage}
                    loading="lazy"
                  />
                </a>
              );
            })}
        </div>
      )}

      {hasCode && !codeCollapsed && (
        <div className={styles.toolCallCodePreview}>
          <SyntaxHighlighter
            language={codePreview.language}
            style={oneDark}
            customStyle={highlighterCustomStyle}
            wrapLongLines
            codeTagProps={{ style: {} }}
          >
            {codePreview.code}
          </SyntaxHighlighter>
        </div>
      )}

      {displayContent && (
        <div
          className={`${styles.toolCallOutputSection} ${outputCollapsed ? styles.outputCollapsed : ""}`}
        >
          <div
            className={styles.toolCallOutputHeader}
            onClick={(e) => {
              e.stopPropagation();
              setOutputCollapsed(!outputCollapsed);
            }}
          >
            <span
              className={`${styles.toolCallIcon} ${!outputCollapsed ? styles.toolCallIconOpen : ""}`}
            >
              <CaretRightOutlined />
            </span>
            Output
            {outputLines > 0 && (
              <span className={styles.toolCallOutputHint}>
                {trimmed
                  ? `tail of ${outputLines.toLocaleString()} lines`
                  : `${outputLines.toLocaleString()} lines`}
              </span>
            )}
          </div>
          {!outputCollapsed && (
            <div className={styles.toolCallOutput} ref={outputRef}>
              <pre>{displayContent}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default ToolCallBlock;
