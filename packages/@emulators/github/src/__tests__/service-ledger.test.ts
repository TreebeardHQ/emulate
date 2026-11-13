import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubService } from "../index.js";

const base = "http://localhost";
const service = () => createGitHubService({
  seed: {
    users: [{ login: "fixture-user" }],
    tokens: { "ghp_fixture_token": { login: "fixture-user", scopes: ["repo", "admin:repo_hook"] } },
    repos: [{ owner: "fixture-user", name: "project" }],
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
});
