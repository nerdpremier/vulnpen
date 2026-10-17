import assert from "node:assert/strict";
import test from "node:test";
import {
  MIN_PASSWORD_LENGTH,
  validatePasswordChange,
} from "../src/utils/passwordPolicy";

test("a complete, matching change is accepted", () => {
  const result = validatePasswordChange({
    currentPassword: "old-secret-1",
    newPassword: "new-secret-2",
    confirmPassword: "new-secret-2",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result, {
    ok: true,
    currentPassword: "old-secret-1",
    newPassword: "new-secret-2",
  });
});

test("every field is required", () => {
  for (const missing of ["currentPassword", "newPassword", "confirmPassword"]) {
    const body: Record<string, string> = {
      currentPassword: "old-secret-1",
      newPassword: "new-secret-2",
      confirmPassword: "new-secret-2",
    };
    delete body[missing];
    const result = validatePasswordChange(body);
    assert.equal(result.ok, false, `${missing} must be required`);
  }
});

test("non-string values are rejected rather than coerced", () => {
  const result = validatePasswordChange({
    currentPassword: { $ne: null },
    newPassword: "new-secret-2",
    confirmPassword: "new-secret-2",
  });
  assert.equal(result.ok, false);
});

test("a short new password is rejected", () => {
  const result = validatePasswordChange({
    currentPassword: "old-secret-1",
    newPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
    confirmPassword: "a".repeat(MIN_PASSWORD_LENGTH - 1),
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /at least 8/);
});

test("the confirmation must match exactly", () => {
  const result = validatePasswordChange({
    currentPassword: "old-secret-1",
    newPassword: "new-secret-2",
    confirmPassword: "new-secret-3",
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /do not match/);
});

test("reusing the current password is rejected", () => {
  const result = validatePasswordChange({
    currentPassword: "same-secret-1",
    newPassword: "same-secret-1",
    confirmPassword: "same-secret-1",
  });
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.message : "", /different/);
});
