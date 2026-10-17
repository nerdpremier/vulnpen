export const MIN_PASSWORD_LENGTH = 8;

export type PasswordChangeInput = {
  currentPassword?: unknown;
  newPassword?: unknown;
  confirmPassword?: unknown;
};

export type PasswordChangeValidation =
  | { ok: true; currentPassword: string; newPassword: string }
  | { ok: false; message: string };

export type NewPasswordValidation =
  | { ok: true; newPassword: string }
  | { ok: false; message: string };

/**
 * The rules a new password must satisfy, wherever it is set: a signed-in
 * password change, or a reset from the sign-in page. Kept free of Express and
 * Mongo so the API and its tests assert exactly the same thing.
 */
export function validatePasswordValue(
  newPassword: unknown,
): NewPasswordValidation {
  const next = typeof newPassword === "string" ? newPassword : "";

  if (!next) {
    return { ok: false, message: "A new password is required" };
  }
  if (next.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    };
  }

  return { ok: true, newPassword: next };
}

export function validateNewPassword(
  newPassword: unknown,
  confirmPassword: unknown,
): NewPasswordValidation {
  const confirm = typeof confirmPassword === "string" ? confirmPassword : "";

  if (!confirm) {
    return { ok: false, message: "New password and confirmation are required" };
  }

  const policy = validatePasswordValue(newPassword);
  if (!policy.ok) return policy;

  if (policy.newPassword !== confirm) {
    return { ok: false, message: "New password and confirmation do not match" };
  }

  return policy;
}

/**
 * Rules for a self-service password change.
 *
 * The current password is required even though the caller already holds a
 * session: it is what stops a borrowed browser from locking the real owner out
 * of the account. The new password must differ from the old one, so a "change"
 * can never silently leave the same secret in place.
 */
export function validatePasswordChange(
  input: PasswordChangeInput,
): PasswordChangeValidation {
  const current =
    typeof input.currentPassword === "string" ? input.currentPassword : "";
  const next = typeof input.newPassword === "string" ? input.newPassword : "";
  const confirm =
    typeof input.confirmPassword === "string" ? input.confirmPassword : "";

  if (!current || !next || !confirm) {
    return {
      ok: false,
      message: "Current password, new password and confirmation are required",
    };
  }

  const policy = validateNewPassword(next, confirm);
  if (!policy.ok) return policy;

  if (policy.newPassword === current) {
    return {
      ok: false,
      message: "New password must be different from the current password",
    };
  }

  return { ok: true, currentPassword: current, newPassword: policy.newPassword };
}
