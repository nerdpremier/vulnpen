import React from "react";
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

/** Wording per safety kind. "dangerous" is a destructive pattern on the attack
 *  box; "destructive_target" is a destructive action against the engagement
 *  target, which a proof-of-concept engagement never carries out; "out_of_scope"
 *  is a target outside the declared boundary, a much milder verdict that used to
 *  be shown with the destructive wording and read as nonsense for a plain curl. */
const SAFETY_KIND_LABELS = {
  dangerous: {
    badge: "อันตราย — ต้องขออนุมัติ",
    title: "คำสั่งนี้อาจทำลายระบบ — ตรวจสอบก่อนอนุมัติ",
  },
  destructive_target: {
    badge: "ทำลายข้อมูลเป้าหมาย — ต้องขออนุมัติ",
    title: "รายการนี้ลบหรือแก้ไขข้อมูลบนเป้าหมาย — งานนี้เป็นแบบ PoC",
  },
  out_of_scope: {
    badge: "นอกขอบเขต — ต้องขออนุมัติ",
    title: "คำสั่งนี้แตะเป้าหมายนอกขอบเขตการทดสอบ",
  },
};

function safetyKindOf(action) {
  if (action.safetyKind) return action.safetyKind;
  // Older pending-consent records only carry the boolean.
  return action.safetyBlock ? "dangerous" : undefined;
}

const highlighterCustomStyle = {
  margin: 0,
  borderRadius: "6px",
  fontSize: "0.78rem",
  background: "rgba(0, 0, 0, 0.4)",
  maxHeight: "300px",
};

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
    : [{ toolName, args, safetyBlock, approvalReason, safetyReason, safetyImpact, safetyKind }];
  const isBatch = actions.length > 1;
  const kinds = new Set(actions.map(safetyKindOf).filter(Boolean));
  // Only a destructive pattern earns the red "may destroy the system" wording.
  const dangerVerdict = kinds.has("dangerous") || kinds.has("destructive_target");
  const destructiveVerdict = kinds.has("destructive_target");
  const scopeVerdict = kinds.has("out_of_scope");
  const hasSafetyBlock = actions.some((action) => action.safetyBlock);

  const badgeLabel = dangerVerdict
    ? SAFETY_KIND_LABELS.dangerous.badge
    : scopeVerdict
      ? SAFETY_KIND_LABELS.out_of_scope.badge
      : "ต้องขออนุมัติ";
  const headerTitle = isBatch
    ? "มีหลายรายการที่ต้องขออนุมัติ"
    : dangerVerdict
      ? SAFETY_KIND_LABELS.dangerous.title
      : scopeVerdict
        ? SAFETY_KIND_LABELS.out_of_scope.title
        : config.title;

  return (
    <div className={styles.consentBanner}>
      <div className={styles.consentInfo}>
        <div className={styles.consentHeader}>
          <div className={styles.consentBadge}>
            <ExclamationCircleOutlined />
            <span>{badgeLabel}</span>
          </div>
          <div className={styles.consentTitleGroup}>
            <div className={styles.consentTitle}>{headerTitle}</div>
            <div className={styles.consentSubtitle}>
              {isBatch
                ? "กดอนุมัติจะรันทุกรายการด้านล่างพร้อมกัน"
                : destructiveVerdict
                  ? "งานนี้เป็นแบบ PoC — ระบบหยุดไว้ก่อน เพื่อไม่ให้ข้อมูลจริงบนเป้าหมายถูกลบหรือแก้ไข"
                  : hasSafetyBlock
                    ? "ระบบขอความยินยอมก่อนปล่อยคำสั่งนี้ผ่าน"
                    : "เอเจนต์ขออนุญาตก่อนทำรายการนี้"}
            </div>
          </div>
          <div className={styles.consentActions}>
            <button
              className={styles.consentApproveBtn}
              onClick={onApprove}
              title="อนุมัติ"
              aria-label="อนุมัติ"
            >
              <CheckOutlined />
              <span>อนุมัติ</span>
            </button>
            <button
              className={styles.consentDenyBtn}
              onClick={onDeny}
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
          return (
            <div
              key={action.toolCallId ?? `${action.toolName}-${index}`}
              className={styles.consentCodePreview}
              style={{ marginTop: index === 0 ? "0.65rem" : "0.65rem" }}
            >
              {isBatch && (
                <div className={styles.consentItemLabel}>
                  <strong>{index + 1}. {actionConfig.title}</strong>
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
