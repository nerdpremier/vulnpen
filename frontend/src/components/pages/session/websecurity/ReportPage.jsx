"use client";

import React, { useCallback, useState } from "react";
import { App, Button, Dropdown } from "antd";
import {
  DownloadOutlined,
  FileMarkdownOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  MoreOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery } from "react-query";
import { PageShell, PageState } from "@/components/common/ui";
import { useConfirmPopUp } from "@/components/common/ConfirmPopUp";
import { apiErrorMessage } from "@/utils/apiError";
import { saveBlob } from "@/utils/download";
import {
  downloadReportDocx,
  downloadReportMarkdown,
  downloadReportPdf,
  getWordEditorUrl,
} from "@/services/websecurity.service";
import styles from "@/styles/components/Report.module.scss";

/**
 * The report is LibreOffice (Collabora) itself: the page opens the engagement's
 * working .docx in the Word editor, where Ctrl+S / autosave writes it back
 * through the WOPI endpoints.
 *
 * The editor is the page — no title bar, no toolbar strip above it — so the
 * actions that belong to the document (exports, reopen, regenerate) float over
 * the editor's own corner. Two things they exist to be honest about: the
 * document is deliberately never regenerated after a Word save (so later
 * findings never reach it), and the API can hand back a .docx, a PDF and the
 * markdown source.
 */
export default function ReportPage({ sessionId }) {
  const { message } = App.useApp();
  const confirmPopUp = useConfirmPopUp();
  const [busy, setBusy] = useState(null);

  const editorQuery = useQuery(
    ["report-editor", sessionId],
    () => getWordEditorUrl(sessionId),
    { enabled: !!sessionId, retry: false, staleTime: 0 },
  );

  const editedByWord = editorQuery.data?.editedByWord === true;

  const save = useCallback(
    async (kind, fetcher) => {
      setBusy(kind);
      try {
        const { blob, fileName } = await fetcher(sessionId);
        saveBlob(blob, fileName);
        message.success(`Saved ${fileName}`);
      } catch (error) {
        message.error(apiErrorMessage(error, "Could not build that export"));
      } finally {
        setBusy(null);
      }
    },
    [sessionId, message],
  );

  const regenerate = useCallback(
    () =>
      confirmPopUp({
        title: "Regenerate the report from current results?",
        content:
          "The document currently holds edits made in Word. Regenerating discards them and rebuilds the report from the engagement's scans, findings and test plan — the only way later work reaches the report.",
        okText: "Regenerate",
        onOk: async () => {
          const data = await getWordEditorUrl(sessionId, { rebuild: true });
          editorQuery.refetch();
          return data;
        },
      }),
    [confirmPopUp, sessionId, editorQuery],
  );

  /* The document's provenance, stated in the menu. It cannot be a strip above
     the editor — the editor is the page, and the one chrome fact this surface
     has would then cost it a row — and a floating badge would sit on top of
     Collabora's own toolbar. */
  const provenance = editedByWord
    ? "Edited in Word — later scans and findings are not merged into this document"
    : "Generated from the plan, scans and findings as they stand";

  const menuItems = [
    {
      key: "provenance",
      disabled: true,
      label: <span className={styles.menuState}>{provenance}</span>,
    },
    { type: "divider" },
    {
      key: "md",
      icon: <FileMarkdownOutlined />,
      label: "Download Markdown",
      onClick: () => save("md", downloadReportMarkdown),
    },
    {
      key: "docx",
      icon: <DownloadOutlined />,
      label: "Download .docx",
      onClick: () => save("docx", downloadReportDocx),
    },
    {
      key: "pdf",
      icon: <FilePdfOutlined />,
      label: "Download PDF",
      onClick: () => save("pdf", downloadReportPdf),
    },
    { type: "divider" },
    {
      key: "reopen",
      icon: <ReloadOutlined />,
      label: "Reopen the editor",
      onClick: () => editorQuery.refetch(),
    },
    {
      key: "regenerate",
      icon: <FileWordOutlined />,
      label: "Regenerate from current results",
      onClick: regenerate,
    },
  ];

  if (editorQuery.isLoading) {
    return (
      <PageShell width="full">
        <PageState state="loading" rows={4} />
      </PageShell>
    );
  }

  if (editorQuery.isError) {
    return (
      <PageShell width="full">
        <PageState
          state="error"
          title="Could not open the report editor"
          description={apiErrorMessage(
            editorQuery.error,
            "The Word editor could not be opened. Check that the Collabora service is running and reachable from this browser.",
          )}
          onRetry={() => editorQuery.refetch()}
        />
      </PageShell>
    );
  }

  return (
    <PageShell
      width="full"
      className={styles.reportPage}
      innerClassName={styles.reportInner}
    >
      <div className={styles.frame}>
        <iframe
          className={styles.editor}
          src={editorQuery.data.url}
          title="LibreOffice Writer — report"
          allow="clipboard-read; clipboard-write"
        />

        <div className={styles.floatingActions}>
          <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="topRight">
            <Button
              className={styles.fab}
              shape="circle"
              icon={<MoreOutlined />}
              loading={busy != null}
              title={
                editedByWord
                  ? "Edited in Word — later scans and findings are not merged into this document"
                  : "Report actions"
              }
              aria-label="Report actions"
            />
          </Dropdown>
          {editedByWord && <span className={styles.fabDot} aria-hidden="true" />}
        </div>
      </div>
    </PageShell>
  );
}
