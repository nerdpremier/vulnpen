const abortControllers = new Map<string, AbortController>();

export function hasActiveController(sessionId: string): boolean {
  const ctrl = abortControllers.get(sessionId);
  return !!ctrl && !ctrl.signal.aborted;
}

export function reserveAbortController(sessionId: string): AbortController | null {
  if (abortControllers.has(sessionId)) return null;
  const ctrl = new AbortController();
  abortControllers.set(sessionId, ctrl);
  return ctrl;
}

export function releaseAbortController(
  sessionId: string,
  ctrl: AbortController,
): void {
  if (abortControllers.get(sessionId) === ctrl) {
    abortControllers.delete(sessionId);
  }
}

export function abortSession(sessionId: string): void {
  const ctrl = abortControllers.get(sessionId);
  if (!ctrl) return;
  ctrl.abort();
}
