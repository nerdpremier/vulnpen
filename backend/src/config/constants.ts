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

export const KALI_DATA_DIR = process.env.KALI_DATA_DIR || "../kali-data";
