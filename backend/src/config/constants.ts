export function getVncDisplay(): string {
  return process.env.VNC_DISPLAY || ":89";
}
export function getVncRfbPort(): number {
  return parseInt(process.env.VNC_RFBPORT || "5989", 10);
}
export function getWebsockifyPort(): number {
  return parseInt(process.env.WEBSOCKIFY_PORT || "9020", 10);
}

// The Magnitude browser agent runs its own VNC stack, separate from the Kali
// GUI one above. Kept in sync with backend/entrypoint.sh.
export function getBrowserAgentDisplay(): string {
  return process.env.DISPLAY || ":99";
}
export function getBrowserAgentRfbPort(): number {
  return parseInt(process.env.BROWSER_AGENT_VNC_RFB_PORT || "5999", 10);
}
export function getBrowserAgentNovncPort(): number {
  return parseInt(process.env.BROWSER_AGENT_NOVNC_PORT || "6080", 10);
}

/**
 * The host-published port that bridges the ATTACK BOX's desktop to the operator.
 *
 * Not the same thing as BROWSER_AGENT_NOVNC_PORT above: that one serves the
 * backend's own display, which is not where the agent's browser runs. The attack
 * box sits only on internal Docker networks, so its own noVNC port can never be
 * published — Docker has no route from the host into an internal network. The
 * backend is on `control` (which does reach the attack box) and is published, so
 * it serves a second noVNC bridge pointed at the attack box (entrypoint.sh).
 *
 * 0 means the deployment does not bridge it, and the operator is expected to
 * reach the attack box directly (or through VNC_BASE_URL).
 */
export function getOperatorDesktopPort(): number {
  return parseInt(process.env.BROWSER_AGENT_DESKTOP_PORT || "0", 10) || 0;
}

export const KALI_DATA_DIR = process.env.KALI_DATA_DIR || "../kali-data";
