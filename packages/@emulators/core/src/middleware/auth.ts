import type { Context, Next } from "../http.js";
import { createPublicKey } from "crypto";
import { jwtVerify } from "jose";
import { debug } from "../debug.js";

export interface AuthUser {
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export interface AuthApp {
  appId: number;
  slug: string;
  name: string;
}

export interface AuthInstallation {
  installationId: number;
  appId: number;
  accountId: number;
  accountType: "User" | "Organization";
  permissions: Record<string, string>;
  repositoryIds: number[];
  repositorySelection: "all" | "selected";
}

export type TokenMap = Map<string, AuthUser>;

export interface TokenEntry {
  token: string;
  login: string;
  id: number;
  scopes: string[];
  installation?: AuthInstallation;
}

export function serializeTokenMap(tokenMap: TokenMap): TokenEntry[] {
  return [...tokenMap.entries()].map(([token, user]) => ({
    token,
    login: user.login,
    id: user.id,
    scopes: user.scopes,
    ...(user.installation ? { installation: user.installation } : {}),
  }));
}

export function restoreTokenMap(tokenMap: TokenMap, tokens: TokenEntry[]): void {
  tokenMap.clear();
  for (const t of tokens) {
    tokenMap.set(t.token, {
      login: t.login,
      id: t.id,
      scopes: t.scopes,
      ...(t.installation ? { installation: t.installation } : {}),
    });
  }
}

export type AppEnv = {
  Variables: {
    authUser?: AuthUser;
    authApp?: AuthApp;
    authToken?: string;
    authScopes?: string[];
    docsUrl?: string;
  };
};

export interface AppKeyResolver {
  (appId: number): { privateKey: string; slug: string; name: string } | null;
}

export interface AuthFallback {
  login: string;
  id: number;
  scopes: string[];
}

const APP_JWT_MAX_LIFETIME_SECONDS = 10 * 60;
const APP_JWT_CLOCK_SKEW_SECONDS = 60;

function hasValidAppJwtClaims(payload: unknown): payload is { iss: string | number; iat: number; exp: number } {
  if (!payload || typeof payload !== "object") return false;
  const claims = payload as Record<string, unknown>;
  const issuer = claims.iss;
  const issuerText = typeof issuer === "number" ? String(issuer) : issuer;
  const appId = typeof issuerText === "string" && /^\d+$/.test(issuerText) ? Number(issuerText) : NaN;
  const issuedAt = claims.iat;
  const expiresAt = claims.exp;
  if (
    !Number.isSafeInteger(appId) || appId <= 0 ||
    typeof issuedAt !== "number" || !Number.isFinite(issuedAt) ||
    typeof expiresAt !== "number" || !Number.isFinite(expiresAt)
  ) return false;

  const now = Math.floor(Date.now() / 1000);
  // GitHub recommends backdating iat by one minute while setting exp ten minutes ahead.
  return issuedAt <= now + APP_JWT_CLOCK_SKEW_SECONDS &&
    expiresAt > now &&
    expiresAt <= now + APP_JWT_MAX_LIFETIME_SECONDS &&
    expiresAt - issuedAt <= APP_JWT_MAX_LIFETIME_SECONDS + APP_JWT_CLOCK_SKEW_SECONDS;
}

export function authMiddleware(tokens: TokenMap, appKeyResolver?: AppKeyResolver, fallbackUser?: AuthFallback) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (authHeader) {
      const token = authHeader.replace(/^(Bearer|token)\s+/i, "").trim();

      if (token.startsWith("eyJ") && appKeyResolver) {
        try {
          const [, payloadB64] = token.split(".");
          const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
          if (!hasValidAppJwtClaims(payload)) throw new Error("Invalid GitHub App JWT claims");
          const appId = typeof payload.iss === "string" ? parseInt(payload.iss, 10) : payload.iss;

          if (typeof appId === "number" && !isNaN(appId)) {
            const appInfo = appKeyResolver(appId);
            if (appInfo) {
              const publicKey = createPublicKey(appInfo.privateKey);
              await jwtVerify(token, publicKey, { algorithms: ["RS256"] });
              c.set("authApp", {
                appId,
                slug: appInfo.slug,
                name: appInfo.name,
              } satisfies AuthApp);
            }
          }
        } catch {
          // JWT verification failed
        }
      } else {
        let user = tokens.get(token);
        if (!user && fallbackUser && token.length > 0) {
          debug("auth", "fallback user for unknown token", { login: fallbackUser.login, id: fallbackUser.id });
          user = { login: fallbackUser.login, id: fallbackUser.id, scopes: fallbackUser.scopes };
        }
        if (user) {
          c.set("authUser", user);
          c.set("authToken", token);
          c.set("authScopes", user.scopes);
        }
      }
    }
    await next();
  };
}

export function requireAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authUser")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "Requires authentication",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}

export function requireAppAuth() {
  return async (c: Context, next: Next) => {
    if (!c.get("authApp")) {
      const docsUrl = (c.get("docsUrl") as string | undefined) ?? "https://emulate.dev";
      return c.json(
        {
          message: "A JSON web token could not be decoded",
          documentation_url: docsUrl,
        },
        401,
      );
    }
    await next();
  };
}
