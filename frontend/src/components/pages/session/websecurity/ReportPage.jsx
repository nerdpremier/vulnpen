"use client";

import React, { useEffect, useState } from "react";
import { Alert, App, Button, Spin } from "antd";
import { ArrowLeftOutlined, FileWordOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { apiErrorMessage } from "@/utils/apiError";
import { getWordEditorUrl } from "@/services/websecurity.service";
import styles from "@/styles/pages/TestPlan.module.scss";

/**
 * The report page is LibreOffice (Collabora) itself: Report opens straight
 * into the Word editor and saving is the editor's own Ctrl+S / autosave, which
 * writes the .docx back through the WOPI endpoints on the backend.
 */
export default function ReportPage({ sessionId }) {
  const { message } = App.useApp();
  const router = useRouter();
  const [editor, setEditor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getWordEditorUrl(sessionId)
      .then((data) => {
        if (!cancelled) setEditor(data);
      })
      .catch((err) => {
        console.error(err);
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  return (
    <div className={styles.page} style={{ display: "flex", flexDirection: "column", minHeight: "calc(100vh - 60px)" }}>
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "8px 4px",
        }}
      >
        <Button
          icon={<ArrowLeftOutlined />}
          onClick={() => router.push(`/session/${sessionId}/test-plan`)}
        >
          แผนทดสอบ
        </Button>
        <span style={{ fontWeight: 600, fontSize: 15 }}>
          รายงานผลการทดสอบเจาะระบบเว็บแอปพลิเคชัน (LibreOffice Writer)
        </span>
        <span style={{ color: "var(--secondary-text, #999)", fontSize: 13 }}>
          บันทึกด้วย Ctrl+S หรือปล่อยให้บันทึกอัตโนมัติ
        </span>
      </header>

      {loading && (
        <div className={styles.fullState}>
          <Spin tip="กำลังเปิดรายงานใน LibreOffice...">
            <div style={{ width: 120, height: 80 }} />
          </Spin>
        </div>
      )}

      {!loading && error && (
        <Alert
          type="error"
          showIcon
          message="เปิดรายงานแบบ Word ไม่สำเร็จ"
          description={apiErrorMessage(error, "ตรวจว่า service Collabora (port 9980) ทำงานอยู่")}
        />
      )}

      {!loading && editor && (
        <iframe
          src={editor.url}
          title="LibreOffice Writer — report"
          style={{ width: "100%", flex: 1, minHeight: "calc(100vh - 160px)", border: 0, display: "block" }}
          allow="clipboard-read; clipboard-write"
        />
      )}
    </div>
  );
}
