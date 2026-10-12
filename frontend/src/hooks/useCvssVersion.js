"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DEFAULT_CVSS_VERSION,
  readCvssVersion,
  subscribeCvssVersion,
  writeCvssVersion,
} from "@/utils/cvssVersion.mjs";

/**
 * The engagement-wide CVSS version the finding surfaces read in.
 *
 * The choice lives outside React — persisted so it survives navigation, and
 * announced so a surface that is already mounted follows — so it is read
 * through `useSyncExternalStore` rather than mirrored into local state. The
 * store snapshot is the stored version string (a primitive, so it is stable
 * between renders while nothing changes); the server snapshot is the default,
 * which keeps the first paint free of a hydration mismatch and lets the client
 * reconcile to the chosen value on the next render.
 *
 * Writing goes through the same module, so the picker in one surface moves the
 * header, chart and rows in the other.
 */
export default function useCvssVersion() {
  const versionId = useSyncExternalStore(
    subscribeCvssVersion,
    readCvssVersion,
    () => DEFAULT_CVSS_VERSION,
  );

  const select = useCallback((next) => writeCvssVersion(next), []);

  return [versionId, select];
}
