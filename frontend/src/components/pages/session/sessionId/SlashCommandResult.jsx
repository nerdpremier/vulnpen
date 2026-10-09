import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "@/styles/components/Chat.module.scss";

/**
 * The result card for a slash command (`/summarize`, `/wstg`, …).
 *
 * The content is transcript-derived — the agent writes it from tool output and
 * model text, both of which contain whatever the target application returned —
 * so it is rendered as markdown through react-markdown, never as HTML. This
 * used to hand-roll `**bold**`/`# heading` with regular expressions and inject
 * the result with `dangerouslySetInnerHTML`, which executed any markup that
 * arrived inside a scanned page's response.
 */
export default function SlashCommandResult({ message }) {
  const { command, content, success } = message;

  return (
    <div className={styles.slashCommandResult}>
      <div className={styles.slashCommandHeader}>
        <span className={styles.slashCommandIcon}>{success ? "⚡" : "⚠"}</span>
        <span className={styles.slashCommandLabel}>/{command}</span>
      </div>
      <div className={styles.slashCommandContent}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content ?? ""}</ReactMarkdown>
      </div>
    </div>
  );
}
