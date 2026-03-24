import { randomBytes, pbkdf2Sync, timingSafeEqual } from "crypto";
import type { Request, Response, Router } from "express";
import * as store from "./store";

type GoogleUserInfo = {
  sub: string;
  email?: string;
  name?: string;
  picture?: string;
};

type AuthUser = {
  id: string;
  provider: "google" | "password" | "agent";
  providerUserId: string;
  email: string | null;
  name: string;
  picture: string | null;
};

type SessionRecord = {
  user: AuthUser;
  expiresAt: number;
};

type PendingState = {
  returnTo: string;
  expiresAt: number;
};

const SESSION_COOKIE = "uhmm_session";
const OAUTH_STATE_COOKIE = "uhmm_google_oauth_state";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const STATE_TTL_MS = 10 * 60 * 1000;
const sessions = new Map<string, SessionRecord>();
const pendingStates = new Map<string, PendingState>();

function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out: Record<string, string> = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i <= 0) return;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    out[key] = decodeURIComponent(value);
  });
  return out;
}

function appendCookie(res: Response, value: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", value);
    return;
  }
  const list = Array.isArray(existing) ? existing.map(String) : [String(existing)];
  list.push(value);
  res.setHeader("Set-Cookie", list);
}

function setCookie(
  req: Request,
  res: Response,
  name: string,
  value: string,
  opts?: { maxAgeSec?: number; httpOnly?: boolean }
): void {
  const maxAgeSec = opts?.maxAgeSec;
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "SameSite=Lax"];
  if (typeof maxAgeSec === "number") parts.push(`Max-Age=${maxAgeSec}`);
  if (opts?.httpOnly !== false) parts.push("HttpOnly");
  if (req.secure) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

function clearCookie(req: Request, res: Response, name: string): void {
  const parts = [`${name}=`, "Path=/", "Max-Age=0", "SameSite=Lax"];
  if (req.secure) parts.push("Secure");
  appendCookie(res, parts.join("; "));
}

function sanitizeReturnTo(val: unknown): string {
  const input = typeof val === "string" ? val.trim() : "";
  if (!input) return "/";
  if (!input.startsWith("/")) return "/";
  if (input.startsWith("//")) return "/";
  return input;
}

function getGoogleConfig(req: Request): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} | null {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim() || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || "";
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI?.trim() ||
    `${req.protocol}://${req.get("host")}/api/auth/google/callback`;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, redirectUri };
}

const PASSWORD_ITERATIONS = 100000;
const PASSWORD_KEYLEN = 64;
const PASSWORD_SALT_LEN = 16;

function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const saltBytes = salt ? Buffer.from(salt, "hex") : randomBytes(PASSWORD_SALT_LEN);
  const saltHex = saltBytes.toString("hex");
  const hash = pbkdf2Sync(password, saltBytes, PASSWORD_ITERATIONS, PASSWORD_KEYLEN, "sha256");
  return { hash: hash.toString("hex"), salt: saltHex };
}

function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  if (hash.length !== storedHash.length) return false;
  try {
    return timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

function getSessionIdFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return parseCookies(req)[SESSION_COOKIE] || null;
}

function getSessionFromRequest(req: Request): SessionRecord | null {
  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

async function exchangeCodeForTokens(code: string, cfg: { clientId: string; clientSecret: string; redirectUri: string }) {
  const body = new URLSearchParams({
    code,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google token exchange failed: ${text}`);
  }
  return (await res.json()) as { access_token?: string };
}

async function fetchGoogleUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Google userinfo failed: ${text}`);
  }
  return (await res.json()) as GoogleUserInfo;
}

function createSessionForUser(user: AuthUser): string {
  const sessionId = randomToken(24);
  sessions.set(sessionId, { user, expiresAt: Date.now() + SESSION_TTL_MS });
  return sessionId;
}

export function registerAuthRoutes(api: Router): void {
  api.get("/auth/me", (req: Request, res: Response) => {
    const session = getSessionFromRequest(req);
    if (!session) return res.json({ authenticated: false });
    return res.json({ authenticated: true, user: session.user });
  });

  api.post("/auth/register", (req: Request, res: Response) => {
    const body = req.body;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    const name = typeof body?.name === "string" ? body.name.trim() : undefined;
    const userType = body?.userType === "agent" ? "agent" : body?.userType === "human" ? "human" : undefined;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const existing = store.getUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: "Email already registered" });
    }

    const { hash, salt } = hashPassword(password);
    const user = store.createUser({ email: email.toLowerCase(), passwordHash: hash, passwordSalt: salt, name, userType });

    const authUser: AuthUser = {
      id: user.id,
      provider: userType === "agent" ? "agent" : "password",
      providerUserId: user.id,
      email: user.email,
      name: user.name || user.email,
      picture: null,
    };
    const sessionId = createSessionForUser(authUser);
    setCookie(req, res, SESSION_COOKIE, sessionId, { maxAgeSec: Math.floor(SESSION_TTL_MS / 1000), httpOnly: true });

    return res.status(201).json({
      ok: true,
      user: { id: authUser.id, email: authUser.email, name: authUser.name, userType: user.userType },
      sessionToken: sessionId,
    });
  });

  api.post("/auth/login", (req: Request, res: Response) => {
    const body = req.body;
    const email = typeof body?.email === "string" ? body.email.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const user = store.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const authUser: AuthUser = {
      id: user.id,
      provider: user.userType === "agent" ? "agent" : "password",
      providerUserId: user.id,
      email: user.email,
      name: user.name || user.email,
      picture: null,
    };
    const sessionId = createSessionForUser(authUser);
    setCookie(req, res, SESSION_COOKIE, sessionId, { maxAgeSec: Math.floor(SESSION_TTL_MS / 1000), httpOnly: true });

    return res.json({
      ok: true,
      user: { id: authUser.id, email: authUser.email, name: authUser.name, userType: user.userType },
      sessionToken: sessionId,
    });
  });

  api.post("/auth/logout", (req: Request, res: Response) => {
    const cookies = parseCookies(req);
    const sessionId = cookies[SESSION_COOKIE];
    if (sessionId) sessions.delete(sessionId);
    clearCookie(req, res, SESSION_COOKIE);
    res.json({ ok: true });
  });

  api.get("/auth/google/start", (req: Request, res: Response) => {
    const cfg = getGoogleConfig(req);
    if (!cfg) {
      return res.status(501).json({
        error:
          "Google auth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.",
      });
    }
    const state = randomToken(18);
    const returnTo = sanitizeReturnTo(req.query.returnTo);
    pendingStates.set(state, { returnTo, expiresAt: Date.now() + STATE_TTL_MS });
    setCookie(req, res, OAUTH_STATE_COOKIE, state, { maxAgeSec: Math.floor(STATE_TTL_MS / 1000), httpOnly: true });
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      prompt: "select_account",
      access_type: "online",
    });
    return res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
  });

  api.get("/auth/google/callback", async (req: Request, res: Response) => {
    const cfg = getGoogleConfig(req);
    if (!cfg) {
      return res.status(501).send("Google auth is not configured on the server.");
    }
    const code = typeof req.query.code === "string" ? req.query.code : "";
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const cookies = parseCookies(req);
    const cookieState = cookies[OAUTH_STATE_COOKIE];
    const pending = pendingStates.get(state);
    pendingStates.delete(state);
    clearCookie(req, res, OAUTH_STATE_COOKIE);
    if (!code || !state || !cookieState || cookieState !== state || !pending || pending.expiresAt <= Date.now()) {
      return res.status(400).send("Invalid or expired OAuth state. Please try again.");
    }
    try {
      const tokens = await exchangeCodeForTokens(code, cfg);
      if (!tokens.access_token) {
        return res.status(502).send("Google token exchange did not return an access token.");
      }
      const info = await fetchGoogleUserInfo(tokens.access_token);
      if (!info.sub) {
        return res.status(502).send("Google user profile did not include a user id.");
      }
      const creatorId = `google_${info.sub}`;
      const user: AuthUser = {
        id: creatorId,
        provider: "google",
        providerUserId: info.sub,
        email: info.email ?? null,
        name: info.name?.trim() || info.email?.trim() || creatorId,
        picture: info.picture ?? null,
      };
      const sessionId = randomToken(24);
      sessions.set(sessionId, { user, expiresAt: Date.now() + SESSION_TTL_MS });
      setCookie(req, res, SESSION_COOKIE, sessionId, { maxAgeSec: Math.floor(SESSION_TTL_MS / 1000), httpOnly: true });
      return res.redirect(pending.returnTo || "/");
    } catch (err) {
      console.error("Google OAuth callback failed:", err);
      return res.status(502).send("Google login failed. Check API logs for details.");
    }
  });
}

export function getAuthenticatedUser(req: Request): AuthUser | null {
  const session = getSessionFromRequest(req);
  return session?.user ?? null;
}
