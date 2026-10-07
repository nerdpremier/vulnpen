import React from "react";
import { Checkbox } from "antd";
import { CheckOutlined, CloseOutlined, ExclamationCircleOutlined } from "@ant-design/icons";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/cjs/styles/prism";
import styles from "@/styles/components/Chat.module.scss";

const CONSENT_CONFIG = {
  run_install_tool: {
    title: "ติดตั้งเครื่องมือใหม่ลงเครื่องทดสอบ",
    getCode: (args) => args?.tool_name ? `Install: ${args.tool_name}` : "",
    language: "text",
  },
  run_bash: {
    title: "รันคำสั่งบนเครื่องทดสอบ",
    getCode: (args) => args?.command ?? "",
    language: "bash",
  },
  run_python_script: {
    title: "รันสคริปต์ Python บนเครื่องทดสอบ",
    getCode: (args) => args?.script ?? "",
    language: "python",
  },
  write_to_shell: {
    title: "ส่งข้อความเข้าเชลล์ที่เปิดค้างไว้",
    getCode: (args) => args?.input ?? "",
    language: "bash",
  },
};

const DEFAULT_CONFIG = {
  title: "เรียกใช้เครื่องมือ",
  getCode: (args) => (args?.command ?? JSON.stringify(args, null, 2)),
  language: "text",
};

const GENERIC_SAFETY_REASON = "คำสั่งนี้ข้ามเส้นแบ่งการอนุมัติตามกฎความปลอดภัยของระบบ";
const GENERIC_SAFETY_IMPACT = "อาจทำให้เครื่องทดสอบหรือข้อมูลเสียหาย";

const highlighterCustomStyle = {
  margin: 0,
  borderRadius: "6px",
  fontSize: "0.78rem",
  background: "rgba(0, 0, 0, 0.4)",
  maxHeight: "300px",
};

/**
 * The stable identity of one item in the batch. Real batches always carry a
 * `toolCallId`; the fallback only covers malformed data, and an id the backend
 * does not recognise can only ever be *refused* — never silently approved.
 */
const itemKey = (action, index) =>
  action.toolCallId ?? `${action.toolName}-${index}`;

export default function ConsentBanner({ pendingConsent, onApprove, onDeny }) {
  const { toolName, safetyBlock, approvalReason, safetyReason, safetyImpact, safetyKind } =
    pendingConsent;
  const args = pendingConsent.args ?? pendingConsent.arguments;
  const config = CONSENT_CONFIG[toolName] ?? DEFAULT_CONFIG;
  const actions = pendingConsent.batch?.length
    ? pendingConsent.batch.map((action) => ({
        ...action,
        args: action.args ?? action.arguments,
      }))
    : [{ toolCallId: pendingConsent.toolCallId, toolName, args, safetyBlock, approvalReason, safetyReason, safetyImpact, safetyKind }];
  const isBatch = actions.length > 1;
  // The system flagged at least one action as crossing a safety boundary: the
  // card has to look different from a routine "may I install this" prompt.
  const isBlocked = actions.some((action) => action.safetyBlock);

  // Approval is one-shot: the request resolves asynchronously and the banner
  // unmounts when the agent answers, so a double click must not send twice.
  const [sent, setSent] = React.useState(false);
  // Everything is ticked to begin with, so the default is exactly the old
  // all-or-nothing approval; unticking is how an operator refuses one action of
  // a mixed batch while letting the rest run.
  const [ticked, setTicked] = React.useState(
    () => new Set(actions.map(itemKey)),
  );
  const respond = (handler, payload) => {
    if (sent) return;
    setSent(true);
    handler?.(payload);
  };

  const toggle = (key) => {
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // One calm wording for every approval request: the reason / impact rows on
  // each item carry the specific why, so the header no longer grades verdicts.
  const badgeLabel = isBlocked ? "ต้องขออนุมัติ — ถูกตั้งค่าความปลอดภัย" : "ต้องขออนุมัติ";
  const headerTitle = isBatch ? "มีหลายรายการที่ต้องขออนุมัติ" : config.title;

  return (
    <div
      className={`${styles.consentBanner} ${isBlocked ? styles.consentBannerDanger : ""}`}
      role="alert"
      aria-live="assertive"
    >
      <div className={styles.consentInfo}>
        <div className={styles.consentHeader}>
          <div
            className={`${styles.consentBadge} ${isBlocked ? styles.consentBadgeDanger : ""}`}
          >
            <ExclamationCircleOutlined />
            <span>{badgeLabel}</span>
          </div>
          <div className={styles.consentTitleGroup}>
            <div className={styles.consentTitle}>{headerTitle}</div>
            <div className={styles.consentSubtitle}>
              {isBatch
                ? "กดอนุมัติจะรันทุกรายการด้านล่างพร้อมกัน"
                : "เอเจนต์ขออนุญาตก่อนทำรายการนี้"}
            </div>
          </div>
          <div className={styles.consentActions}>
            <button
              className={styles.consentApproveBtn}
              onClick={() =>
                respond(onApprove, actions
                  .map(itemKey)
                  .filter((key) => ticked.has(key)))
              }
              disabled={sent || ticked.size === 0}
              title="อนุมัติ"
              aria-label="อนุมัติ"
            >
              <CheckOutlined />
              <span>
                อนุมัติ
                {isBatch ? ` (${ticked.size}/${actions.length})` : ""}
              </span>
            </button>
            <button
              className={styles.consentDenyBtn}
              onClick={() => respond(onDeny)}
              disabled={sent}
              title="ปฏิเสธ"
              aria-label="ปฏิเสธ"
            >
              <CloseOutlined />
              <span>ปฏิเสธ</span>
            </button>
          </div>
        </div>
        {actions.map((action, index) => {
          const actionConfig = CONSENT_CONFIG[action.toolName] ?? DEFAULT_CONFIG;
          const code = actionConfig.getCode(action.args);
          const reason = action.safetyReason ?? (action.safetyBlock ? GENERIC_SAFETY_REASON : action.approvalReason);
          const impact = action.safetyImpact ?? (action.safetyBlock ? GENERIC_SAFETY_IMPACT : undefined);
          const key = itemKey(action, index);
          return (
            <div
              key={key}
              className={styles.consentCodePreview}
              style={{ marginTop: index === 0 ? "0.65rem" : "0.65rem" }}
            >
              {isBatch && (
                <div className={styles.consentItemLabel}>
                  {/* Per-item approval: the operator can let the read-only
                      probe run and refuse the boundary-crossing one, instead
                      of the whole batch sharing one verdict. */}
                  <Checkbox
                    checked={ticked.has(key)}
                    disabled={sent}
                    onChange={() => toggle(key)}
                  >
                    <strong>{index + 1}. {actionConfig.title}</strong>
                  </Checkbox>
                  {action.safetyBlock && (
                    <span className={styles.consentItemBlocked}>
                      ถูกตั้งค่าความปลอดภัย
                    </span>
                  )}
                </div>
              )}
              {code && (
                <SyntaxHighlighter
                  language={actionConfig.language}
                  style={oneDark}
                  customStyle={highlighterCustomStyle}
                  wrapLongLines
                >
                  {code}
                </SyntaxHighlighter>
              )}
              {(reason || impact) && (
                <div className={styles.consentExplain}>
                  {reason && (
                    <div className={styles.consentExplainRow}>
                      <span className={styles.consentExplainLabel}>เหตุผล</span>
                      <span>{reason}</span>
                    </div>
                  )}
                  {impact && (
                    <div className={styles.consentExplainRow}>
                      <span className={`${styles.consentExplainLabel} ${styles.consentExplainLabelDanger}`}>ผลกระทบ</span>
                      <span>{impact}</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
