"use client";

import React, { useMemo, useState } from "react";
import { Button, Checkbox, Input } from "antd";
import { FiChevronDown, FiChevronRight, FiSearch } from "react-icons/fi";
import styles from "@/styles/pages/TestPlan.module.scss";

/** A case's recorded outcome, in the shortest honest words. */
const STATUS_LABEL = {
  not_started: "not run",
  in_progress: "running",
  passed: "passed",
  failed: "failed",
  blocked: "blocked",
  skipped: "skipped",
};

/**
 * The WSTG case board: one row per category, each with its own select-all, a share
 * bar and an expandable list of the cases it holds — the picker both "Set up the
 * test plan" and the New scan dialog put in front of an operator, so the two read
 * and behave the same. The board scrolls inside a fixed frame, so a long
 * hand-picked set never grows the dialog it sits in.
 *
 * Which cases exist and what is selected stay with the caller (the plan holds
 * catalogue cases, a scan holds plan cases); this owns only the searching, the
 * folding and the drawing. Selection is a Set of case ids handed back whole, so a
 * caller can intersect it with whatever it considers in scope.
 *
 * @param {Array<{code: string, name: string, items: Array<{id: string, title: string, status?: string}>}>} groups
 * @param {Set<string>} selected
 * @param {(next: Set<string>) => void} onChange
 * @param {string} [className] extra class on the board frame, for a caller that
 *   wants the board itself to scroll (a dialog with little else in it) rather
 *   than letting its whole body scroll.
 */
export default function CaseBoard({ groups, selected, onChange, className }) {
  const [query, setQuery] = useState("");
  const [openCategories, setOpenCategories] = useState(() => new Set());

  const total = useMemo(
    () => groups.reduce((sum, group) => sum + group.items.length, 0),
    [groups],
  );
  const allIds = useMemo(
    () => groups.flatMap((group) => group.items.map((item) => item.id)),
    [groups],
  );

  const needle = query.trim().toLowerCase();
  const matches = (item) =>
    !needle ||
    item.id.toLowerCase().includes(needle) ||
    (item.title ?? "").toLowerCase().includes(needle);

  const toggleId = (id, checked) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  const setCategory = (items, checked) => {
    const next = new Set(selected);
    for (const item of items) {
      if (checked) next.add(item.id);
      else next.delete(item.id);
    }
    onChange(next);
  };

  const toggleOpen = (code) =>
    setOpenCategories((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <div className={styles.casePicker}>
      <div className={styles.casePickerBar}>
        <Input
          className={styles.caseSearch}
          allowClear
          prefix={<FiSearch />}
          placeholder="Search cases"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className={styles.casePickerCount}>
          {selected.size} of {total}
        </span>
        <div className={styles.casePickerActions}>
          <Button
            size="small"
            type="link"
            disabled={selected.size >= total}
            onClick={() => onChange(new Set(allIds))}
          >
            Select all
          </Button>
          <Button
            size="small"
            type="link"
            disabled={selected.size === 0}
            onClick={() => onChange(new Set())}
          >
            Clear
          </Button>
        </div>
      </div>

      <div
        className={`${styles.categoryPicker} ${styles.caseBoard} ${className ?? ""}`}
      >
        {groups.map((group) => {
          const shown = group.items.filter(matches);
          if (shown.length === 0) return null;
          const picked = group.items.filter((item) => selected.has(item.id)).length;
          const allPicked = picked === group.items.length;
          // A search unfolds whatever it matched; otherwise a category opens by hand.
          const isOpen = openCategories.has(group.code) || needle.length > 0;
          return (
            <div key={group.code} className={styles.categoryRow}>
              <div className={styles.categoryHead}>
                <Checkbox
                  checked={allPicked}
                  indeterminate={picked > 0 && !allPicked}
                  onChange={(event) => setCategory(group.items, event.target.checked)}
                >
                  <span className={styles.categoryText}>
                    <span className={styles.categoryName}>
                      {group.code}
                      {group.name ? ` · ${group.name}` : ""}
                    </span>
                    <span className={styles.categoryMeta}>
                      {picked}/{group.items.length} cases
                    </span>
                  </span>
                </Checkbox>
                {/* The share of this category the selection covers. */}
                <span
                  className={styles.categoryBar}
                  role="img"
                  aria-label={`${picked} of ${group.items.length} cases selected`}
                  title={`${picked} of ${group.items.length} cases selected`}
                >
                  <span
                    className={styles.categoryBarFill}
                    style={{
                      width: `${
                        group.items.length ? (picked / group.items.length) * 100 : 0
                      }%`,
                    }}
                  />
                </span>
                <button
                  type="button"
                  className={styles.categoryToggle}
                  aria-label={isOpen ? "Hide cases" : "Show cases"}
                  aria-expanded={isOpen}
                  onClick={() => toggleOpen(group.code)}
                >
                  {isOpen ? <FiChevronDown /> : <FiChevronRight />}
                </button>
              </div>
              {isOpen && (
                <div className={styles.caseList}>
                  {shown.map((item) => (
                    <Checkbox
                      key={item.id}
                      checked={selected.has(item.id)}
                      onChange={(event) => toggleId(item.id, event.target.checked)}
                    >
                      <span className={styles.caseText}>
                        <span className={styles.caseLine}>
                          <span className={styles.caseId}>{item.id}</span>
                          {/* A case the plan already ran carries its result here, so
                              keeping it reads as "and keep the result". */}
                          {item.status && (
                            <>
                              <span
                                className={styles.chipSwatch}
                                data-status={item.status}
                              />
                              <span className={styles.caseStatus}>
                                {STATUS_LABEL[item.status] ?? "not run"}
                              </span>
                            </>
                          )}
                        </span>
                        <span className={styles.caseName}>{item.title}</span>
                      </span>
                    </Checkbox>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
