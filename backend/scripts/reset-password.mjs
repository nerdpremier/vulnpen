#!/usr/bin/env node
/**
 * Break-glass password reset, for the one case the UI cannot cover: the
 * installation owner has forgotten their own password, so nobody is left who
 * can issue a reset code.
 *
 *   docker compose exec backend pnpm reset-password -- --email owner@example.com
 *   docker compose exec backend pnpm reset-password -- --email owner@example.com --password 'NewSecret123'
 *
 * With no --password a random one is generated and printed once. The same
 * fields the API clears on a successful reset are cleared here, so a lockout
 * or a half-used code cannot survive it.
 */
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import crypto from "crypto";

function readArg(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    console.error(`${name} needs a value`);
    process.exit(1);
  }
  return value;
}

const email = readArg("--email") ?? process.env.RESET_EMAIL;
if (!email) {
  console.error(
    "Usage: pnpm reset-password -- --email <address> [--password <new password>]",
  );
  process.exit(1);
}

const generated = !readArg("--password") && !process.env.RESET_PASSWORD;
const password =
  readArg("--password") ??
  process.env.RESET_PASSWORD ??
  crypto.randomBytes(9).toString("base64url");

if (password.length < 8) {
  console.error("The new password must be at least 8 characters.");
  process.exit(1);
}

const uri =
  process.env.MONGO_URI ??
  process.env.mongo_uri ??
  "mongodb://mongodb:27017/vulnpen";

try {
  await mongoose.connect(uri);
  const users = mongoose.connection.collection("users");

  const user = await users.findOne({ email });
  if (!user) {
    console.error(`No account uses the email ${email}.`);
    process.exitCode = 1;
  } else {
    await users.updateOne(
      { _id: user._id },
      {
        $set: {
          password: await bcrypt.hash(password, 10),
          failedLoginCount: 0,
          lockedUntil: null,
        },
      },
    );

    console.log(`Password updated for ${email}.`);
    if (generated) console.log(`New password: ${password}`);
  }
} catch (error) {
  console.error("Reset failed:", error?.message ?? error);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
