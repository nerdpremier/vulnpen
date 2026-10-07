import styles from "./ui.module.scss";

/**
 * One square per planned test case, grouped by WSTG category.
 *
 * A category row used to be a bar and "9/10". The bar gives the ratio, but not
 * *why* it is 9: nine passed and one blocked looks identical to nine passed and
 * one failed. A square per case carries the ratio in how much of the row is
 * filled and the outcome in its colour, so a category that is missing work at
 * a glance looks different from one that settled cleanly.
 *
 * Not a chart library and not a canvas: 97 spans that inherit the palette and
 * keep their tooltips.
 *
 * @param rows     [{ key, label, cells: [{ id, status }] }] — `status` is a
 *                 WSTG case status (`passed | failed | blocked | in_progress |
 *                 not_started | skipped`)
 * @param summary  optional counts keyed by status; they become the colour key
 *                 under the grid, so the swatches and the squares are one
 *                 definition instead of two that can drift
 */
const SETTLED = new Set(["passed", "failed", "blocked"]);

const STATUS_LABEL = {
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  in_progress: "in progress",
  not_started: "not started",
  skipped: "skipped",
};

/* The three outcomes every settlement produces, then the states worth naming
   only when they exist: "0 skipped" is a row of pixels saying nothing. */
const LEGEND = [
  { key: "passed", label: "passed", always: true },
  { key: "failed", label: "failed", always: true },
  { key: "blocked", label: "blocked", always: true },
  { key: "in_progress", label: "in progress" },
  { key: "skipped", label: "skipped" },
  { key: "not_started", label: "not started" },
];

const CaseMatrix = ({ rows = [], summary = null, className = "" }) => {
  const legend = summary
    ? LEGEND.filter((entry) => entry.always || summary[entry.key] > 0)
    : [];

  return (
    <div className={[styles.caseMatrix, className].filter(Boolean).join(" ")}>
      {rows.map((row) => {
        const cells = row.cells ?? [];
        const settled = cells.filter((cell) => SETTLED.has(cell.status)).length;

        return (
          <div key={row.key} className={styles.matrixRow}>
            <span className={styles.matrixLabel} title={row.label}>
              {row.key}
            </span>
            <span className={styles.matrixCells}>
              {cells.map((cell) => (
                <span
                  key={cell.id}
                  className={`${styles.matrixCell} ${styles[`cell_${cell.status}`] ?? ""}`}
                  title={`${cell.id} — ${STATUS_LABEL[cell.status] ?? cell.status}`}
                />
              ))}
            </span>
            <span className={styles.matrixCount}>
              {settled}/{cells.length}
            </span>
          </div>
        );
      })}

      {legend.length > 0 && (
        <ul className={styles.matrixLegend}>
          {legend.map((entry) => (
            <li key={entry.key} className={styles.matrixLegendItem}>
              <span
                className={`${styles.matrixLegendSwatch} ${styles[`cell_${entry.key}`] ?? ""}`}
                aria-hidden="true"
              />
              <b>{summary[entry.key] ?? 0}</b>
              <span>{entry.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default CaseMatrix;
