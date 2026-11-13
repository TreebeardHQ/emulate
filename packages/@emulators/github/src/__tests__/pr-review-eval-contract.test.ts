import { describe, expect, it, vi } from "vitest";
import { Hono, Store, WebhookDispatcher, authMiddleware, createApiErrorHandler, createErrorHandler, type AppEnv, type TokenMap } from "@emulators/core";
import { githubPlugin, getGitHubStore, seedFromConfig } from "../index.js";

const base = "http://localhost:4000";

function setup() {
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  const tokens: TokenMap = new Map([
    ["reviewer", { login: "reviewer[bot]", id: 20, scopes: ["repo"] }],
    ["author", { login: "octocat", id: 1, scopes: ["repo"] }],
  ]);
  const app = new Hono<AppEnv>();
  app.onError(createApiErrorHandler());
  app.use("*", createErrorHandler());
  app.use("*", authMiddleware(tokens, (appId) => {
    const ghApp = getGitHubStore(store).apps.findOneBy("app_id", appId);
    return ghApp ? { privateKey: ghApp.private_key, slug: ghApp.slug, name: ghApp.name } : null;
  }));
  githubPlugin.register(app, store, webhooks, base, tokens);
  githubPlugin.seed?.(store, base);
  seedFromConfig(store, base, {
    users: [{ login: "octocat" }, { login: "reviewer[bot]" }],
    repos: [{ owner: "octocat", name: "hello-world" }],
  });
  return { app, store, tokens, webhooks };
}

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

async function createPullRequest(app: Hono<AppEnv>, token = "author") {
  const commits = await app.request(`${base}/repos/octocat/hello-world/commits/main`, { headers: headers(token) });
  const commit = await commits.json() as { sha: string };
  const branch = await app.request(`${base}/repos/octocat/hello-world/git/refs`, {
    method: "POST", headers: headers(token),
    body: JSON.stringify({ ref: "refs/heads/feature", sha: commit.sha }),
  });
  expect(branch.status).toBe(201);
  const response = await app.request(`${base}/repos/octocat/hello-world/pulls`, {
    method: "POST", headers: headers(token),
    body: JSON.stringify({ title: "Feature", head: "feature", base: "main" }),
  });
  expect(response.status).toBe(201);
  return await response.json() as { number: number; head: { sha: string } };
}

const mergeGateQuery = "query MergeGate($owner:String!,$repo:String!,$number:Int!){ repository(owner:$owner,name:$repo){ pullRequest(number:$number){ state isDraft headRefOid author{login} headRepository{nameWithOwner} mergeStateStatus baseRef{branchProtectionRule{requiredApprovingReviewCount requiredStatusCheckContexts requiredStatusChecks{context app{databaseId}}}} } } }";

describe("PR review eval API contracts", () => {
  it("exposes the exact MergeGate GraphQL protection projection and refuses forbidden reads", async () => {
    const { app, store, tokens } = setup();
    const pr = await createPullRequest(app);
    const protection = await app.request(`${base}/repos/octocat/hello-world/branches/main/protection`, {
      method: "PUT", headers: headers("author"),
      body: JSON.stringify({
        required_status_checks: { strict: true, contexts: ["cofactor / proofs"], checks: [{ context: "cofactor / proofs", app_id: 777 }] },
        required_pull_request_reviews: { required_approving_review_count: 1 },
      }),
    });
    expect(protection.status).toBe(200);
    const repo = getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!;
    getGitHubStore(store).repos.update(repo.id, { private: true });
    const owner = getGitHubStore(store).users.findOneBy("login", "octocat")!;
    tokens.set("limited-install", {
      login: "review-app[bot]", id: 100,
      scopes: ["pull_requests:read"],
      installation: {
        installationId: 100, appId: 100, accountId: owner.id, accountType: "User",
        permissions: { pull_requests: "read" }, repositoryIds: [repo.id], repositorySelection: "selected",
      },
    });
    const response = await app.request(`${base}/graphql`, {
      method: "POST", headers: headers("author"),
      body: JSON.stringify({ query: mergeGateQuery, variables: { owner: "octocat", repo: "hello-world", number: pr.number } }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { repository: { pullRequest: {
        state: "OPEN", isDraft: false, headRefOid: pr.head.sha,
        author: { login: "octocat" }, headRepository: { nameWithOwner: "octocat/hello-world" },
        baseRef: { branchProtectionRule: {
          requiredApprovingReviewCount: 1,
          requiredStatusCheckContexts: ["cofactor / proofs"],
          requiredStatusChecks: [{ context: "cofactor / proofs", app: { databaseId: 777 } }],
        } },
      } } },
    });
    const forbidden = await app.request(`${base}/graphql`, {
      method: "POST", headers: headers("limited-install"),
      body: JSON.stringify({
        query: mergeGateQuery,
        variables: { owner: "octocat", repo: "hello-world", number: pr.number },
      }),
    });
    expect(forbidden.status).toBe(200);
    expect(await forbidden.json()).toMatchObject({ errors: [{ type: "FORBIDDEN", extensions: { code: "FORBIDDEN" } }] });
    const privateResponse = await app.request(`${base}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: mergeGateQuery, variables: { owner: "octocat", repo: "hello-world", number: pr.number } }),
    });
    expect(privateResponse.status).toBe(401);
    const inaccessiblePrivateRead = await app.request(`${base}/graphql`, {
      method: "POST", headers: { ...headers("reviewer"), "Content-Type": "application/json" },
      body: JSON.stringify({ query: mergeGateQuery, variables: { owner: "octocat", repo: "hello-world", number: pr.number } }),
    });
    expect(inaccessiblePrivateRead.status).toBe(200);
    expect(await inaccessiblePrivateRead.json()).toMatchObject({ data: { repository: null } });
    getGitHubStore(store).repos.update(repo.id, { private: false });
    const anonymousPublicRead = await app.request(`${base}/graphql`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: mergeGateQuery, variables: { owner: "octocat", repo: "hello-world", number: pr.number } }),
    });
    expect(anonymousPublicRead.status).toBe(401);
  });

  it("projects repository roles from explicit and organization grants", async () => {
    const { app, store } = setup();
    const gh = getGitHubStore(store);
    const repo = gh.repos.findOneBy("full_name", "octocat/hello-world")!;
    const reviewer = gh.users.findOneBy("login", "reviewer[bot]")!;
    for (const [assigned, permission, role] of [["pull", "read", "read"], ["triage", "read", "triage"], ["push", "write", "write"], ["maintain", "write", "maintain"], ["admin", "admin", "admin"]] as const) {
      gh.collaborators.insert({ repo_id: repo.id, user_id: reviewer.id, permission: assigned });
      const response = await app.request(`${base}/repos/octocat/hello-world/collaborators/reviewer[bot]/permission`, { headers: headers("author") });
      expect(await response.json()).toMatchObject({ permission, role_name: role });
      for (const collaboration of gh.collaborators.findBy("repo_id", repo.id)) gh.collaborators.delete(collaboration.id);
    }
    const noAccess = await app.request(`${base}/repos/octocat/hello-world/collaborators/reviewer[bot]/permission`, { headers: headers("author") });
    expect(await noAccess.json()).toMatchObject({ permission: "none", role_name: "none" });
  });

  it("does not apply an organization default permission to known outsiders", async () => {
    const { app, store, tokens } = setup();
    tokens.set("outsider", { login: "outsider", id: 30, scopes: ["repo"] });
    tokens.set("collaborator", { login: "collaborator", id: 31, scopes: ["repo"] });
    seedFromConfig(store, base, {
      users: [{ login: "outsider" }, { login: "collaborator" }],
      orgs: [{ login: "sample-org", members: [{ login: "reviewer[bot]" }] }],
      repos: [{ owner: "sample-org", name: "private-project", private: true }],
    });
    const gh = getGitHubStore(store);
    const org = gh.orgs.findOneBy("login", "sample-org")!;
    gh.orgs.update(org.id, { default_repository_permission: "write" });
    const repo = gh.repos.findOneBy("full_name", "sample-org/private-project")!;
    const collaborator = gh.users.findOneBy("login", "collaborator")!;
    gh.collaborators.insert({ repo_id: repo.id, user_id: collaborator.id, permission: "maintain" });

    const role = async (login: string) => {
      const response = await app.request(`${base}/repos/sample-org/private-project/collaborators/${login}/permission`, {
        headers: headers("reviewer"),
      });
      expect(response.status).toBe(200);
      return await response.json();
    };
    expect(await role("reviewer[bot]")).toMatchObject({ permission: "write", role_name: "write" });
    expect(await role("outsider")).toMatchObject({ permission: "none", role_name: "none" });
    expect(await role("collaborator")).toMatchObject({ permission: "write", role_name: "maintain" });

    const hiddenRepo = await app.request(`${base}/repos/sample-org/private-project`, { headers: headers("outsider") });
    expect(hiddenRepo.status).toBe(404);
    const hiddenPermission = await app.request(`${base}/repos/sample-org/private-project/collaborators/outsider/permission`, {
      headers: headers("outsider"),
    });
    expect(hiddenPermission.status).toBe(404);
  });

  it("rejects author self-approval and self change requests with 422", async () => {
    const { app } = setup();
    const pr = await createPullRequest(app);
    for (const event of ["APPROVE", "REQUEST_CHANGES"]) {
      const response = await app.request(`${base}/repos/octocat/hello-world/pulls/${pr.number}/reviews`, {
        method: "POST", headers: headers("author"), body: JSON.stringify({ event }),
      });
      expect(response.status).toBe(422);
    }
  });

  it("reads the latest commit statuses under the statuses permission and serves thread replies", async () => {
    const { app, store, tokens } = setup();
    const pr = await createPullRequest(app);
    const repo = getGitHubStore(store).repos.findOneBy("full_name", "octocat/hello-world")!;
    const owner = getGitHubStore(store).users.findOneBy("login", "octocat")!;
    tokens.set("status-reader", {
      login: "review-app[bot]", id: 100, scopes: ["statuses:read"],
      installation: {
        installationId: 100, appId: 100, accountId: owner.id, accountType: "User",
        permissions: { statuses: "read" }, repositoryIds: [repo.id], repositorySelection: "selected",
      },
    });
    tokens.set("status-writer", {
      login: "review-app[bot]", id: 100, scopes: ["statuses:write"],
      installation: {
        installationId: 100, appId: 100, accountId: owner.id, accountType: "User",
        permissions: { statuses: "write" }, repositoryIds: [repo.id], repositorySelection: "selected",
      },
    });
    for (const state of ["pending", "success"]) {
      const created = await app.request(`${base}/repos/octocat/hello-world/statuses/${pr.head.sha}`, {
        method: "POST", headers: headers("status-writer"),
        body: JSON.stringify({ state, context: "ci" }),
      });
      expect(created.status).toBe(201);
    }
    const statuses = await app.request(`${base}/repos/octocat/hello-world/commits/${pr.head.sha}/statuses`, {
      headers: headers("status-reader"),
    });
    expect(statuses.status).toBe(200);
    expect(await statuses.json()).toMatchObject([{ context: "ci", state: "success" }, { context: "ci", state: "pending" }]);
    tokens.set("status-denied", {
      login: "review-app[bot]", id: 100, scopes: ["pull_requests:read"],
      installation: {
        installationId: 100, appId: 100, accountId: owner.id, accountType: "User",
        permissions: { pull_requests: "read" }, repositoryIds: [repo.id], repositorySelection: "selected",
      },
    });
    const denied = await app.request(`${base}/repos/octocat/hello-world/commits/${pr.head.sha}/statuses`, {
      headers: headers("status-denied"),
    });
    expect(denied.status).toBe(403);

    const rootResponse = await app.request(`${base}/repos/octocat/hello-world/pulls/${pr.number}/comments`, {
      method: "POST", headers: headers("reviewer"), body: JSON.stringify({ body: "Review comment" }),
    });
    expect(rootResponse.status).toBe(201);
    const root = await rootResponse.json() as { id: number };
    const reply = await app.request(`${base}/repos/octocat/hello-world/pulls/${pr.number}/comments/${root.id}/replies`, {
      method: "POST", headers: headers("author"), body: JSON.stringify({ body: "Reply" }),
    });
    expect(reply.status).toBe(201);
    expect(await reply.json()).toMatchObject({ in_reply_to_id: root.id, body: "Reply" });
  });

  it("emits ready_for_review when a draft PR becomes ready", async () => {
    const { app, webhooks } = setup();
    const pr = await createPullRequest(app);
    const deliveries: unknown[] = [];
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (_input: Request | string | URL, init?: RequestInit) => {
      deliveries.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 200 });
    });
    try {
      webhooks.register({ url: "https://hooks.example.test/review", owner: "octocat", repo: "hello-world", events: ["pull_request"], active: true });
      const draft = await app.request(`${base}/repos/octocat/hello-world/pulls/${pr.number}`, {
        method: "PATCH", headers: headers("author"), body: JSON.stringify({ draft: true }),
      });
      expect(draft.status).toBe(200);
      const ready = await app.request(`${base}/repos/octocat/hello-world/pulls/${pr.number}`, {
        method: "PATCH", headers: headers("author"), body: JSON.stringify({ draft: false }),
      });
      expect(ready.status).toBe(200);
      expect(deliveries.map((delivery) => (delivery as { action: string }).action)).toEqual(["ready_for_review"]);
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});
