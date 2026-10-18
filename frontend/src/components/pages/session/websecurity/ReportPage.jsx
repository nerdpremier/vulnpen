"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { App, Button, Dropdown, Tooltip } from "antd";
import {
  DownloadOutlined,
  EditOutlined,
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
  downloadReportPdf,
  getWordEditorUrl,
} from "@/services/websecurity.service";
import styles from "@/styles/components/Report.module.scss";

/**
 * The report page opens the document as the client receives it.
 *
 * The deliverable is the PDF — cover, contents, one card per finding — so that
 * is what the page shows. The .docx is the working copy: the tester rewrites it
 * in LibreOffice (Collabora) and saves it back through the WOPI endpoints, so
 * "Edit in Word" swaps the page to the editor and "Preview" swaps it back.
 *
 * A document saved in Word is read back into the layout rather than printed as
 * it stands: its wording replaces the generated wording card by card, so the
 * report keeps its cover and contents and still says what the tester wrote.
 * What it cannot carry is structure — a card deleted or added by hand stays
 * out — which is why the export menu states the document's provenance. An
 * operator who does not know that ships a stale report.
 *
 * The page keeps no chrome of its own: the document takes every pixel the shell
 * can give it, and the actions ride in the shared header slot.
 */
export default function ReportPage({ sessionId }) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(null);
  const [view, setView] = useState("pdf");

  /* Fetched even while the PDF is on screen: `editedByWord` is what the export
     menu reports, and opening the editor is then instant. It also materialises
     the working document, which the .docx export hands back. */
  const editorQuery = useQuery(
    ["report-editor", sessionId],
    () => getWordEditorUrl(sessionId),
    { enabled: !!sessionId, retry: false, staleTime: 0, refetchOnWindowFocus: false },
  );

  /* The PDF is a file, not a page: it comes back as a blob and is shown from an
     object URL, so the browser's own viewer renders it without a second
     authenticated request. Re-fetched whenever the page is asked for it again,
     because a save in Word changes what the next export contains. */
  const pdfQuery = useQuery(["report-pdf", sessionId], () => downloadReportPdf(sessionId), {
    enabled: !!sessionId && view === "pdf",
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });

  const [pdfUrl, setPdfUrl] = useState(null);
  useEffect(() => {
    const blob = pdfQuery.data?.blob;
    if (!blob) {
      setPdfUrl(null);
      return undefined;
    }
    // The response type is what tells the viewer to render rather than download.
    const url = URL.createObjectURL(
      blob.type === "application/pdf" ? blob : new Blob([blob], { type: "application/pdf" }),
    );
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [pdfQuery.data]);

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
     document and not as a floating badge (which would sit on Collabora's own
     toolbar when the editor is open). */
  const provenance = editedByWord
    ? "Edited in Word — its wording is used as written; later scans and findings are not merged in"
    : "Generated from the plan, scans and findings as they stand";

  const menuItems = [
    {
      key: "provenance",
      disabled: true,
      label: <span className={styles.menuState}>{provenance}</span>,
    },
    { type: "divider" },
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

  /* The report's actions, in the same header slot every session page uses.
     Whichever document is on screen, the way to the other one is one button. */
  const actions = useMemo(
    () => (
      <>
        {view === "pdf" ? (
          <Button icon={<EditOutlined />} onClick={() => setView("editor")}>
            Edit in Word
          </Button>
        ) : (
          <>
            <Button icon={<FilePdfOutlined />} onClick={() => setView("pdf")}>
              Preview
            </Button>
            <Tooltip title="Reopen the editor">
              <Button
                icon={<ReloadOutlined />}
                onClick={() => editorQuery.refetch()}
                aria-label="Reopen the editor"
              />
            </Tooltip>
          </>
        )}
        <Dropdown menu={{ items: menuItems }} trigger={["click"]} placement="bottomRight">
          <Button type="primary" icon={<DownloadOutlined />} loading={busy != null}>
            Export
          </Button>
        </Dropdown>
      </>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy, sessionId, view],
  );
  usePublishHeaderActions(actions);

  const renderDocument = () => {
    if (view === "editor") {
      if (editorQuery.isLoading) return <PageState state="loading" rows={4} />;
      if (editorQuery.isError) {
        return (
          <PageState
            state="error"
            title="Could not open the report editor"
            description={apiErrorMessage(
              editorQuery.error,
              "The Word editor could not be opened. Check that the Collabora service is running and reachable from this browser.",
            )}
            onRetry={() => editorQuery.refetch()}
          />
        );
      }
      return (
        <iframe
          className={styles.editor}
          src={editorQuery.data.url}
          title="LibreOffice Writer — report"
          allow="clipboard-read; clipboard-write"
        />
      );
    }

    if (pdfQuery.isLoading) return <PageState state="loading" rows={6} />;
    if (pdfQuery.isError) {
      return (
        <PageState
          state="error"
          title="Could not render the report"
          description={apiErrorMessage(pdfQuery.error, "The PDF could not be built for this engagement.")}
          onRetry={() => pdfQuery.refetch()}
        />
      );
    }
    return pdfUrl ? (
      <iframe className={styles.viewer} src={pdfUrl} title="Report PDF" />
    ) : null;
  };

  return (
    <PageShell width="full" className={styles.reportPage} innerClassName={styles.reportInner}>
      <div className={styles.frame}>{renderDocument()}</div>
    </PageShell>
  );
}
