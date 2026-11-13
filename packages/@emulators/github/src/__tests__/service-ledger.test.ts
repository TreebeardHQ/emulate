import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubService } from "../index.js";

const base = "http://localhost";
const service = () => createGitHubService({
  seed: {
    users: [{ login: "fixture-user" }],
    tokens: { "ghp_fixture_token": { login: "fixture-user", scopes: ["repo", "admin:repo_hook"] } },
    repos: [{ owner: "fixture-user", name: "project" }],
    apps: [{ app_id: 42, slug: "review-bot", name: "Review Bot", private_key: "app_private_fixture", webhook_secret: "app_webhook_fixture" }],
    oauth_apps: [{ client_id: "fixture-client", client_secret: "oauth_secret_fixture", name: "Fixture OAuth", redirect_uris: [] }],
  },
});

const jsonHeaders = { Authorization: "Bearer ghp_fixture_token", "Content-Type": "application/json" };

afterEach(() => vi.unstubAllGlobals());

describe("GitHub service action ledger", () => {
  it("records failed mutations and returns detached allowlisted, redacted evidence", async () => {
    const github = service();
    try {
      const response = await github.fetch(new Request(`${base}/repos/fixture-user/project/pulls/99`, {
        method: "PATCH", headers: jsonHeaders,
        body: JSON.stringify({ title: "Bearer ghp_fixture_token", ignored: "omit" }),
      }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      const ledger = github.getGitHubActionLedger();
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ type: "request", method: "PATCH", status: response.status, actor: "fixture-user" });
      expect(ledger[0]?.input).toEqual({ title: "Bearer [REDACTED]" });
      ledger[0]!.input!.title = "tampered";
      expect(github.getGitHubActionLedger()[0]?.input?.title).toBe("Bearer [REDACTED]");
      expect(github.getGitHubActionLedger()).toHaveLength(1);
    } finally {
      await github.close();
    }
  });

  it("captures completed webhook attempts with a stable replay sequence", async () => {
    const github = service();
    const originalFetch = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
      const createHook = await github.fetch(new Request(`${base}/repos/fixture-user/project/hooks`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ name: "web", active: true, events: ["issues"], config: { url: "https://hooks.example.test", secret: "hook_secret" } }),
      }));
      expect(createHook.status).toBe(201);
      vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
      const issue = await github.fetch(new Request(`${base}/repos/fixture-user/project/issues`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Fixture issue" }),
      }));
      expect(issue.status).toBe(201);
      const ledger = github.getGitHubActionLedger();
      const webhook = ledger.find((entry) => entry.type === "webhook");
      expect(webhook).toMatchObject({ event: "issues", action: "opened", successful: false, status: 503 });
      expect(webhook?.deliverySequence).toEqual(expect.any(Number));
      expect(webhook?.deliveryId).toEqual(expect.any(String));
      expect(JSON.stringify(ledger)).not.toContain("hook_secret");
      const replay = await github.replayDelivery(webhook!.deliverySequence!);
      expect(replay).toMatchObject({ redelivery_of: webhook!.deliverySequence, delivery_id: webhook!.deliveryId, success: false });
      expect(github.getGitHubActionLedger().filter((entry) => entry.type === "webhook")).toHaveLength(2);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      await github.close();
    }
  });

  it("redacts secrets from persisted snapshot text and returns detached nested evidence", async () => {
    const github = service();
    const originalFetch = globalThis.fetch;
    try {
      vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
      const issue = await github.fetch(new Request(`${base}/repos/fixture-user/project/issues`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Fixture issue" }),
      }));
      expect(issue.status).toBe(201);
      const hook = await github.fetch(new Request(`${base}/repos/fixture-user/project/hooks`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ name: "web", active: true, events: ["issues"], config: { url: "https://hooks.example.test", secret: "hook_secret_fixture" } }),
      }));
      expect(hook.status).toBe(201);
      const callback = await github.fetch(new Request(`${base}/login/oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ login: "fixture-user", client_id: "fixture-client", redirect_uri: "https://example.test/callback", scope: "repo" }),
      }));
      const code = new URL(callback.headers.get("location") ?? "https://example.test/").searchParams.get("code") ?? "";
      const exchange = await github.fetch(new Request(`${base}/login/oauth/access_token`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: "fixture-client", client_secret: "oauth_secret_fixture", code, redirect_uri: "https://example.test/callback" }),
      }));
      const accessToken = (await exchange.json() as { access_token: string }).access_token;
      const credentials = Buffer.from("fixture-client:oauth_secret_fixture").toString("base64");
      const revoke = await github.fetch(new Request(`${base}/applications/fixture-client/token`, {
        method: "DELETE", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: accessToken }),
      }));
      expect(revoke.status).toBe(204);
      const body = [
        "ghp_fixture_token", "app_private_fixture", "app_webhook_fixture",
        "oauth_secret_fixture", "hook_secret_fixture", accessToken,
      ].join(" ");
      const comment = await github.fetch(new Request(`${base}/repos/fixture-user/project/issues/1/comments`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ body }),
      }));
      expect(comment.status).toBe(201);
      const state = github.inspectGitHubState();
      const stateText = JSON.stringify(state);
      for (const secret of [
        "ghp_fixture_token", "app_private_fixture", "app_webhook_fixture",
        "oauth_secret_fixture", "hook_secret_fixture", accessToken,
      ]) expect(stateText).not.toContain(secret);
      expect(state.comments[0]?.body).toContain("[REDACTED]");
      state.comments[0]!.body = "tampered";
      expect(github.inspectGitHubState().comments[0]?.body).not.toBe("tampered");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
      await github.close();
    }
  });

  it("drains an accepted webhook mutation before closing and rejects new work", async () => {
    const github = service();
    const originalFetch = globalThis.fetch;
    let releaseDelivery!: (response: Response) => void;
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
    try {
      vi.stubGlobal("fetch", async () => new Response(null, { status: 200 }));
      const hook = await github.fetch(new Request(`${base}/repos/fixture-user/project/hooks`, {
        method: "POST", headers: jsonHeaders,
        body: JSON.stringify({ name: "web", active: true, events: ["issues"], config: { url: "https://hooks.example.test" } }),
      }));
      expect(hook.status).toBe(201);

      vi.stubGlobal("fetch", async () => {
        markDeliveryStarted();
        return new Promise<Response>((resolve) => { releaseDelivery = resolve; });
      });
      const acceptedMutation = github.fetch(new Request(`${base}/repos/fixture-user/project/issues`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Close barrier" }),
      }));
      await deliveryStarted;
      const close = github.close();
      let closeResolved = false;
      void close.then(() => { closeResolved = true; });
      await Promise.resolve();
      expect(closeResolved).toBe(false);
      expect(github.close()).toBe(close);
      await expect(github.fetch(new Request(`${base}/repos/fixture-user/project/issues`, {
        method: "POST", headers: jsonHeaders, body: JSON.stringify({ title: "Rejected after close" }),
      }))).rejects.toThrow("GitHub service is closing or closed");
      await expect(github.importFixture("fixture-user/project", new Uint8Array(), { baseSha: "", refs: {} }))
        .rejects.toThrow("GitHub service is closing or closed");
      await expect(github.replayDelivery(1)).rejects.toThrow("GitHub service is closing or closed");
      expect(() => github.seed({})).toThrow("GitHub service is closing or closed");

      releaseDelivery(new Response(null, { status: 200 }));
      expect((await acceptedMutation).status).toBe(201);
      await close;
      expect(closeResolved).toBe(true);
      expect(github.getGitHubActionLedger()).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "webhook", event: "issues", action: "opened", successful: true, status: 200 }),
      ]));
    } finally {
      if (releaseDelivery) releaseDelivery(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", originalFetch);
      await github.close();
    }
  });
});
