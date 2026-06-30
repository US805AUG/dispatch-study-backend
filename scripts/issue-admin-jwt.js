#!/usr/bin/env node

/**
 * Dev/admin-only one-time helper.
 *
 * Usage:
 *   DATABASE_URL=... JWT_SECRET=... APPLE_AUDIENCE=... node scripts/issue-admin-jwt.js <app_user.id>
 *
 * This script:
 *   - requires an exact app_user UUID
 *   - selects that row before changing anything
 *   - promotes only that row to owner if it is not already owner/admin
 *   - selects that row again after the update
 *   - prints only the backend JWT to stdout
 *
 * Verification messages are written to stderr. Do not commit, paste, or log the
 * printed JWT anywhere except the private analytics admin page.
 */

import { issueJwt } from "../src/auth.js";
import { pool, query } from "../src/db.js";

const userId = process.argv[2];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function usage() {
  console.error("Usage: node scripts/issue-admin-jwt.js <app_user.id UUID>");
}

function describeUser(row) {
  return {
    id: row.id,
    emailPresent: Boolean(row.email),
    displayNamePresent: Boolean(row.display_name),
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function main() {
  if (!userId || !uuidPattern.test(userId)) {
    usage();
    process.exitCode = 64;
    return;
  }

  const before = await query(
    "select id, email, display_name, role, created_at, updated_at from app_user where id = $1",
    [userId]
  );

  if (before.rowCount !== 1) {
    console.error(`No app_user row found for id ${userId}. Sign in with Apple in the app first, then retry with the returned userId.`);
    process.exitCode = 66;
    return;
  }

  const beforeUser = before.rows[0];
  console.error("Before:", JSON.stringify(describeUser(beforeUser)));

  if (!["owner", "admin"].includes(beforeUser.role)) {
    await query(
      "update app_user set role = 'owner', updated_at = now() where id = $1",
      [userId]
    );
  }

  const after = await query(
    "select id, email, display_name, role, created_at, updated_at from app_user where id = $1",
    [userId]
  );
  const afterUser = after.rows[0];
  console.error("After:", JSON.stringify(describeUser(afterUser)));

  if (!["owner", "admin"].includes(afterUser.role)) {
    throw new Error("User is still not owner/admin after promotion.");
  }

  const token = await issueJwt({ id: afterUser.id, role: afterUser.role });
  process.stdout.write(`${token}\n`);
}

try {
  await main();
} finally {
  await pool.end();
}
