import { generateKeyPairSync } from "crypto";
import { describe, expect, it } from "vitest";
import {
  Hono,
  Store,
  WebhookDispatcher,
  authMiddleware,
  createApiErrorHandler,
  createErrorHandler,
} from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";
const setupUrl = "https://app.example.com/integrations/github/install/callback";
const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "alice" }, { login: "bob" }],
    // A seeded OAuth app turns on client binding; the installation's code must still exchange.
    oauth_apps: [{ client_id: "Iv1.acme", client_secret: "acme-secret", name: "Acme", redirect_uris: [setupUrl] }],
    orgs: [{ login: "acme", members: [{ login: "alice", role: "admin" }] }],
    apps: [
      {
        app_id: 7,
        slug: "acme-qa",
        name: "Acme QA",
        private_key: appKey.export({ type: "pkcs8", format: "pem" }).toString(),
        installations: [{ installation_id: 70, account: "acme" }],
      },
      {
        app_id: 8,
        slug: "acme-other",
        name: "Acme Other",
        private_key: appKey.export({ type: "pkcs8", format: "pem" }).toString(),
        installations: [{ installation_id: 80, account: "acme" }],
      },
    ],
  });
  return app;
}

function confirm(app: Hono<any>, login: string) {
  return app.request(`${base}/apps/acme-qa/installations/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login, installation_id: "70", redirect_uri: setupUrl, state: "org-state" }),
  });
}

async function userToken(app: Hono<any>, code: string): Promise<string> {
  const res = await app.request(`${base}/login/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: "Iv1.acme", client_secret: "acme-secret", code }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

describe("GitHub App installation flow", () => {
  it("offers each seeded installation to the users who can manage its account", async () => {
    const app = createTestApp();
    for (const page of ["new", "select_target"]) {
      const res = await app.request(
        `${base}/apps/acme-qa/installations/${page}?state=org-state&redirect_uri=${encodeURIComponent(setupUrl)}`,
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/apps/acme-qa/installations/confirm"');
      expect(html).toContain('value="alice"');
      expect(html).not.toContain('value="bob"');
    }
    const missing = await app.request(`${base}/apps/acme-qa/installations/new`);
    expect(missing.status).toBe(400);
  });

  it("redirects to the setup URL with a user code whose token lists only that App's installations", async () => {
    const app = createTestApp();
    const res = await confirm(app, "alice");
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(setupUrl);
    expect(location.searchParams.get("installation_id")).toBe("70");
    expect(location.searchParams.get("setup_action")).toBe("install");
    expect(location.searchParams.get("state")).toBe("org-state");

    const token = await userToken(app, location.searchParams.get("code") ?? "");
    const installations = await app.request(`${base}/user/installations?per_page=100&page=1`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(installations.status).toBe(200);
    expect(await installations.json()).toMatchObject({
      total_count: 1,
      installations: [{ id: 70, app_id: 7, app_slug: "acme-qa", account: { login: "acme", type: "Organization" } }],
    });
  });

  it("refuses a user who cannot manage the account and lists nothing for them", async () => {
    const app = createTestApp();
    expect((await confirm(app, "bob")).status).toBe(400);

    const callback = await app.request(`${base}/login/oauth/callback`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ login: "bob", redirect_uri: setupUrl }),
    });
    const code = new URL(callback.headers.get("location") ?? "").searchParams.get("code") ?? "";
    const installations = await app.request(`${base}/user/installations`, {
      headers: { Authorization: `Bearer ${await userToken(app, code)}` },
    });
    // A plain OAuth token is bound to no App; bob belongs to no account either.
    expect(await installations.json()).toEqual({ total_count: 0, installations: [] });
  });

  it("requires a user token for /user/installations", async () => {
    const app = createTestApp();
    expect((await app.request(`${base}/user/installations`)).status).toBe(401);
  });
});
