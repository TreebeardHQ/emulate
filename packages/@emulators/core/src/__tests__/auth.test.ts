import { describe, it, expect, beforeEach } from "vitest";
import { generateKeyPairSync, sign } from "crypto";
import { Hono } from "../http.js";
import {
  authMiddleware,
  requireAuth,
  requireAppAuth,
  restoreTokenMap,
  serializeTokenMap,
  type TokenMap,
  type AppEnv,
} from "../middleware/auth.js";

describe("authMiddleware", () => {
  let tokenMap: TokenMap;

  beforeEach(() => {
    tokenMap = new Map();
  });

  it("sets authUser on context when the token exists in tokenMap", async () => {
    tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["repo"] });

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.get("/test", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer test-token" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string; id: number; scopes: string[] } };
    expect(body.user).toEqual({ login: "testuser", id: 1, scopes: ["repo"] });
  });

  it("maps unknown tokens to fallbackUser when configured", async () => {
    const fallbackUser = { login: "fallback", id: 99, scopes: ["read:org"] };

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap, undefined, fallbackUser));
    app.get("/test", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/test", {
      headers: { Authorization: "Bearer unknown-secret" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string; id: number; scopes: string[] } };
    expect(body.user).toEqual(fallbackUser);
    expect(tokenMap.has("unknown-secret")).toBe(false);
  });

  it("does not set authUser when there is no Authorization header", async () => {
    tokenMap.set("test-token", { login: "testuser", id: 1, scopes: ["repo"] });

    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.get("/test", (c) => c.json({ user: c.get("authUser") ?? null }));

    const res = await app.request("/test");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: unknown };
    expect(body.user).toBeNull();
  });

  it("preserves installation credentials when token maps are serialized", () => {
    tokenMap.set("installation-token", {
      login: "acme",
      id: 7,
      scopes: ["contents:write"],
      installation: {
        installationId: 42,
        appId: 9,
        accountId: 7,
        accountType: "Organization",
        permissions: { contents: "write" },
        repositoryIds: [12],
        repositorySelection: "selected",
      },
    });

    const restored: TokenMap = new Map();
    restoreTokenMap(restored, serializeTokenMap(tokenMap));
    expect(restored.get("installation-token")).toEqual(tokenMap.get("installation-token"));
  });

  it.each(["pkcs8", "pkcs1"] as const)("sets authApp for a valid GitHub App JWT signed with %s", async (format) => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: format, format: "pem" }).toString();
    const jwt = createAppJwt("42", privateKeyPem);

    const app = new Hono<AppEnv>();
    app.use(
      "*",
      authMiddleware(tokenMap, (appId) => {
        if (appId !== 42) return null;
        return { privateKey: privateKeyPem, slug: "my-app", name: "My App" };
      }),
    );
    app.get("/test", (c) => c.json({ app: c.get("authApp") }));

    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${jwt}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { appId: number; slug: string; name: string } };
    expect(body.app).toEqual({ appId: 42, slug: "my-app", name: "My App" });
  });

  it("rejects signed App JWTs without bounded temporal claims", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const now = Math.floor(Date.now() / 1000);
    const valid = { iss: "42", iat: now - 60, exp: now + 600 };
    const invalidClaims = [
      { iat: now - 60, exp: now + 540 },
      { iss: "42", iat: now - 60 },
      { iss: "42", exp: now + 540 },
      { ...valid, iat: now - 61 },
      { ...valid, iat: now, exp: now + 660 },
      { ...valid, iat: now + 120 },
      { ...valid, exp: now - 1 },
    ];

    for (const claims of invalidClaims) {
      const app = new Hono<AppEnv>();
      app.use("*", authMiddleware(tokenMap, (appId) => appId === 42
        ? { privateKey: privateKeyPem, slug: "my-app", name: "My App" }
        : null));
      app.get("/test", (c) => c.json({ app: c.get("authApp") ?? null }));
      const res = await app.request("/test", {
        headers: { Authorization: `Bearer ${createAppJwt(claims, privateKeyPem)}` },
      });
      expect(await res.json()).toEqual({ app: null });
    }
  });
});

describe("requireAuth", () => {
  let tokenMap: TokenMap;

  beforeEach(() => {
    tokenMap = new Map();
    tokenMap.set("ok-token", { login: "alice", id: 1, scopes: [] });
  });

  it("returns 401 when authUser is not set", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.use("*", requireAuth());
    app.get("/protected", (c) => c.json({ ok: true }));

    const res = await app.request("/protected");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string; documentation_url: string };
    expect(body.message).toBe("Requires authentication");
    expect(body.documentation_url).toBe("https://emulate.dev");
  });

  it("passes through when authUser exists", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(tokenMap));
    app.use("*", requireAuth());
    app.get("/protected", (c) => c.json({ user: c.get("authUser") }));

    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer ok-token" },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { login: string } };
    expect(body.user?.login).toBe("alice");
  });
});

function createAppJwt(claims: Record<string, unknown> | string, privateKey: string): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = typeof claims === "string"
    ? { iat: nowSeconds - 60, exp: nowSeconds + 9 * 60, iss: claims }
    : claims;
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  return `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url")}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("requireAppAuth", () => {
  it("returns 401 when authApp is not set", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", requireAppAuth());
    app.get("/app-route", (c) => c.json({ ok: true }));

    const res = await app.request("/app-route");

    expect(res.status).toBe(401);
    const body = (await res.json()) as { message: string; documentation_url: string };
    expect(body.message).toBe("A JSON web token could not be decoded");
    expect(body.documentation_url).toBe("https://emulate.dev");
  });

  it("passes through when authApp exists", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("authApp", { appId: 42, slug: "my-app", name: "My App" });
      await next();
    });
    app.use("*", requireAppAuth());
    app.get("/app-route", (c) => c.json({ app: c.get("authApp") }));

    const res = await app.request("/app-route");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      app: { appId: number; slug: string; name: string };
    };
    expect(body.app).toEqual({ appId: 42, slug: "my-app", name: "My App" });
  });
});
