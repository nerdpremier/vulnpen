"use client";

import React, { useCallback, useMemo, useState } from "react";
import { App, Button, Dropdown, Tooltip } from "antd";
import {
  DownloadOutlined,
  FileMarkdownOutlined,
  FilePdfOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useQuery } from "react-query";
import { PageShell, PageState } from "@/components/common/ui";
import { usePublishHeaderActions } from "@/components/common/HeaderActions";
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
 * document's actions ride in the shared header slot: reopen the editor, and
 * export the document in any of the three formats the API holds it in. The
 * document is deliberately never regenerated after a Word save, and the menu
 * says so, because an operator who does not know that ships a stale report.
 */
export default function ReportPage({ sessionId }) {
  const { message } = App.useApp();
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

  /* The document's provenance. It lives in the menu, not as a strip above the
     editor (which is the whole page) and not as a floating badge (which would
     sit on Collabora's own toolbar). */
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
  ];

  /* The report's actions, in the same header slot every session page uses. The
     draft is one entry inside Export, not a second button beside it: both would
     call the same endpoint and hand back the same file. */
  const actions = useMemo(
    () => (
      <>
        <Tooltip title="Reopen the editor">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => editorQuery.refetch()}
            aria-label="Reopen the editor"
          />
        </Tooltip>
        <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
          <Button type="primary" icon={<DownloadOutlined />} loading={busy != null}>
            Export
          </Button>
        </Dropdown>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, sessionId],
  );
  usePublishHeaderActions(actions);

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
      </div>
    </PageShell>
  );
}
