import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readAllowRegistrationFlag,
  resolveRegistrationPolicy,
} from "../src/utils/registrationPolicy";

test("the first account of an installation is always allowed", () => {
  const policy = resolveRegistrationPolicy({ existingUsers: 0 });
  assert.equal(policy.open, true);
  assert.equal(policy.bootstrap, true);
  assert.equal(policy.reason, "bootstrap");

  const closedAnyway = resolveRegistrationPolicy({
    existingUsers: 0,
    allowRegistration: "false",
  });
  assert.equal(closedAnyway.open, true, "bootstrap ignores the closed flag");
});

test("registration stays open after the first account unless it is switched off", () => {
  for (const flag of [undefined, null, "", "true", "TRUE", "yes", "1"]) {
    const policy = resolveRegistrationPolicy({
      existingUsers: 4,
      allowRegistration: flag,
    });
    assert.equal(policy.open, true, `flag ${JSON.stringify(flag)}`);
    assert.equal(policy.reason, "open", `flag ${JSON.stringify(flag)}`);
    assert.equal(policy.bootstrap, false);
  }
});

test("an operator can close registration explicitly", () => {
  for (const flag of ["false", "FALSE", "0", "no", "off", "disabled", false]) {
    const policy = resolveRegistrationPolicy({
      existingUsers: 2,
      allowRegistration: flag,
    });
    assert.equal(policy.open, false, `flag ${JSON.stringify(flag)}`);
    assert.equal(policy.reason, "closed", `flag ${JSON.stringify(flag)}`);
  }
});

test("a legacy or missing user count falls back to the bootstrap rule", () => {
  const policy = resolveRegistrationPolicy({
    existingUsers: Number.NaN,
    allowRegistration: "false",
  });
  assert.equal(policy.open, true);
  assert.equal(policy.bootstrap, true);
});

test("the environment variable wins over the managed .env file", () => {
  assert.equal(
    readAllowRegistrationFlag({ ALLOW_REGISTRATION: "false" }, {
      ALLOW_REGISTRATION: "true",
    }),
    "true",
  );
  assert.equal(
    readAllowRegistrationFlag({ ALLOW_REGISTRATION: "false" }, {}),
    "false",
  );
  assert.equal(readAllowRegistrationFlag({}, {}), undefined);
});

test("an empty passthrough variable does not mask the managed .env value", () => {
  assert.equal(
    readAllowRegistrationFlag({ ALLOW_REGISTRATION: "false" }, {
      ALLOW_REGISTRATION: "",
    }),
    "false",
  );
  assert.equal(readAllowRegistrationFlag({}, { ALLOW_REGISTRATION: "   " }), undefined);
});