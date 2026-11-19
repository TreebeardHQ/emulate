import { describe, expect, it } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler } from "@emulators/core";
import type { TokenMap } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function createTestApp() {
  const store = new Store();
  const tokenMap: TokenMap = new Map();
  tokenMap.set("user-token", { login: "alice", id: 1, scopes: ["repo"] });
  const app = new Hono();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokenMap));
  app.use("*", async (c, next) => {
    if (c.req.header("Authorization") === "Bearer app-jwt") {
      c.set("authApp", { appId: 9, slug: "repos-app", name: "Repos App" });
    }
    await next();
  });
  githubPlugin.register(app as any, store, new WebhookDispatcher(), base, tokenMap);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "alice" }],
    orgs: [{ login: "acme" }, { login: "globex" }],
    repos: [
      { owner: "acme", name: "web" },
      { owner: "acme", name: "api" },
      { owner: "globex", name: "site" },
    ],
    apps: [
      {
        app_id: 9,
        slug: "repos-app",
        name: "Repos App",
        private_key: "test-key",
        permissions: { contents: "read" },
        installations: [{ installation_id: 41, account: "acme", repository_selection: "all" }],
      },
    ],
  });
  return app;
}

async function installationToken(app: Hono<any>, body?: Record<string, unknown>): Promise<string> {
  const response = await app.request(`${base}/app/installations/41/access_tokens`, {
    method: "POST",
    headers: { Authorization: "Bearer app-jwt", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function listRepositories(app: Hono<any>, token: string) {
  return app.request(`${base}/installation/repositories`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("GET /installation/repositories", () => {
  it("lists every repository on the installation's account", async () => {
    const app = createTestApp();
    const response = await listRepositories(app, await installationToken(app));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      total_count: number;
      repository_selection: string;
      repositories: Array<{ full_name: string }>;
    };
    expect(body.repository_selection).toBe("all");
    expect(body.total_count).toBe(2);
    expect(body.repositories.map((repo) => repo.full_name).sort()).toEqual(["acme/api", "acme/web"]);
  });

  it("lists only the repositories a narrowed token can reach", async () => {
    const app = createTestApp();
    const response = await listRepositories(app, await installationToken(app, { repositories: ["web"] }));
    const body = (await response.json()) as { repository_selection: string; repositories: Array<{ full_name: string }> };
    expect(body.repository_selection).toBe("selected");
    expect(body.repositories.map((repo) => repo.full_name)).toEqual(["acme/web"]);
  });

  it("rejects a user token", async () => {
    const app = createTestApp();
    expect((await listRepositories(app, "user-token")).status).toBe(401);
  });
});
