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
  TOOL_LABELS,
  parseArgs,
  formatArgsPreview,
  getCodePreview,
} from "@/utils/toolCatalog";
import { stripAnsi, collapseBlankLines } from "@/utils/ansi.mjs";
import {
  CaretRightOutlined,
  LoadingOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";

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
  const [outputCopied, setOutputCopied] = useState(false);
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
    ? collapseBlankLines(stripAnsi(content))
    : content;
  const outputLines = hasContent ? cleanedContent.split("\n").length : 0;
  const displayContent = hasContent
    ? trimmed
      ? "[... earlier output trimmed ...]\n" + cleanedContent.slice(-OUTPUT_WINDOW)
      : cleanedContent
    : null;

  /**
   * Copy the *whole* output, not the tail the panel shows. Output is the
   * evidence a pentester keeps (hashes, nmap, raw responses), and until now the
   * only copy affordance on the block copied the command or the code preview —
   * never the result.
   */
  const handleCopyOutput = useCallback(
    (event) => {
      event.stopPropagation();
      if (!cleanedContent) return;
      copyText(cleanedContent)
        .then(() => {
          setOutputCopied(true);
          setTimeout(() => setOutputCopied(false), 1500);
        })
        .catch(() => {});
    },
    [cleanedContent, copyText],
  );

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
            title={copied ? "Copied!" : hasCode ? "Copy the code" : "Copy the command"}
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
        <div className={styles.toolCallOutputSection}>
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
            <button
              type="button"
              className={`${styles.toolCallCopyBtn} ${outputCopied ? styles.copied : ""}`}
              onClick={handleCopyOutput}
              aria-label="Copy output"
              title={outputCopied ? "Copied!" : "Copy the full output"}
            >
              {outputCopied ? <CheckOutlined /> : <CopyOutlined />}
            </button>
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
