/**
 * Who may create an account on this installation.
 *
 * VulnPen is self-hosted, so the deployment decides. The rules are deliberately
 * simple and explicit:
 *
 * - The first account is always allowed, so a fresh installation can create its
 *   owner without any configuration.
 * - Otherwise registration is open unless `ALLOW_REGISTRATION` is explicitly
 *   falsy. A team deployment can therefore keep onboarding people without
 *   touching the code, and an operator can close the door by setting
 *   `ALLOW_REGISTRATION=false` once the accounts they need exist.
 */

export type RegistrationReason = "bootstrap" | "open" | "closed";

export interface RegistrationPolicy {
  open: boolean;
  reason: RegistrationReason;
  /** True only for the very first account of this installation. */
  bootstrap: boolean;
}

const FALSY = new Set(["false", "0", "no", "off", "disabled"]);

function isExplicitlyDisabled(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === "string") return FALSY.has(value.trim().toLowerCase());
  return false;
}

export function resolveRegistrationPolicy(params: {
  existingUsers: number;
  allowRegistration?: unknown;
}): RegistrationPolicy {
  const existingUsers = Number.isFinite(params.existingUsers)
    ? Math.max(0, params.existingUsers)
    : 0;

  if (existingUsers === 0) {
    return { open: true, reason: "bootstrap", bootstrap: true };
  }

  if (isExplicitlyDisabled(params.allowRegistration)) {
    return { open: false, reason: "closed", bootstrap: false };
  }

  return { open: true, reason: "open", bootstrap: false };
}

/**
 * `ALLOW_REGISTRATION` may come from the process environment (Docker/compose) or
 * from the runtime-managed .env file written by the Settings UI and run.sh.
 */
export function readAllowRegistrationFlag(
  envFile: Record<string, string>,
  processEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromProcess = processEnv.ALLOW_REGISTRATION;
  // Compose files that pass `${ALLOW_REGISTRATION:-}` produce an empty string;
  // treat that as "not set" so the managed .env file still decides.
  if (typeof fromProcess === "string" && fromProcess.trim() !== "") {
    return fromProcess;
  }
  const fromFile = envFile.ALLOW_REGISTRATION;
  return typeof fromFile === "string" && fromFile.trim() !== "" ? fromFile : undefined;
}