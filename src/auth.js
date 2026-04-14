import { jwtVerify, createRemoteJWKSet, SignJWT } from "jose";
import { config } from "./config.js";
import { query } from "./db.js";
import crypto from "crypto";

const appleJWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

export async function verifyAppleIdentityToken(identityToken) {
  if (!identityToken) throw new Error("Missing Apple identity token.");
  const { payload } = await jwtVerify(identityToken, appleJWKS, {
    issuer: "https://appleid.apple.com",
    audience: config.appleAudience,
  });
  return payload;
}

export async function upsertUserFromApplePayload(payload) {
  const appleSub = payload.sub;
  const email = payload.email ?? null;
  const displayName = payload.email ?? "Dispatch Learner";

  const existing = await query(
    "select id, role from app_user where apple_sub = $1",
    [appleSub]
  );

  if (existing.rows.length > 0) {
    const user = existing.rows[0];
    await query(
      "update app_user set email = coalesce($1, email), updated_at = now() where id = $2",
      [email, user.id]
    );
    return { id: user.id, role: user.role };
  }

  const userId = crypto.randomUUID();
  const role = "user";
  await query(
    "insert into app_user (id, apple_sub, email, display_name, role) values ($1, $2, $3, $4, $5)",
    [userId, appleSub, email, displayName, role]
  );
  return { id: userId, role };
}

export async function issueJwt(user) {
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({
    sub: user.id,
    role: user.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime("30d")
    .sign(new TextEncoder().encode(config.jwtSecret));
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.replace("Bearer ", "");
    if (!token) return res.status(401).json({ error: "Missing token" });
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(config.jwtSecret)
    );
    req.user = payload;
    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    const role = req.user?.role;
    if (!role || !roles.includes(role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };
}
