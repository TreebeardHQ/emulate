import { createServer } from "@emulators/core";
import type { ServicePlugin, TokenMap, WebhookDelivery } from "@emulators/core";
import { githubPlugin, seedFromConfig } from "./index.js";
import type { GitHubSeedConfig } from "./index.js";
import { getGitHubStore } from "./store.js";
import { createAppKeyResolver } from "./index.js";
import { createNativeGitStore } from "./native-git.js";
import type { NativeGitPins } from "./native-git.js";
import { projectNativeGit } from "./native-projection.js";
import { registerNativeGitPolicy } from "./native-policy.js";
import { smartHttpRoutes } from "./routes/smart-http.js";
import { getRevokedTokens } from "./tokens.js";

export interface GitHubServiceOptions {
  baseUrl?: string;
  seed?: GitHubSeedConfig;
}

export interface GitHubServiceAction {
  sequence: number;
  deliverySequence?: number;
  type: "request" | "webhook";
  method?: string;
  path?: string;
  actor?: string | null;
  status?: number;
  event?: string;
  action?: string;
  deliveryId?: string;
  redeliveryOf?: number;
  successful?: boolean;
  before?: string;
  after?: string;
  input?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

export interface GitHubStateSnapshot {
  repositories: Array<{ id: number; full_name: string; private: boolean; default_branch: string }>;
  pullRequests: Array<{
    id: number;
    number: number;
    repository: string;
    title: string;
    state: string;
    draft: boolean;
    author: string | null;
    head: { ref: string; sha: string; repository: string | null };
    base: { ref: string; sha: string; repository: string | null };
  }>;
  reviews: Array<{ id: number; number: number; repository: string; author: string | null; state: string; commit_id: string; body: string | null }>;
  comments: Array<{ id: number; number: number | null; repository: string; author: string | null; body: string; in_reply_to_id: number | null; path: string | null; line: number | null; side: string | null; commit_id: string | null }>;
  checks: Array<{ id: number; repository: string; name: string; head_sha: string; status: string; conclusion: string | null; app_id: number | null }>;
  statuses: Array<{ id: number; repository: string; sha: string; context: string; state: string; description: string | null }>;
  protections: Array<{ repository: string; branch: string; approving_reviews: number; required_contexts: string[]; required_checks: Array<{ context: string; app_id: number | null }> }>;
}

export interface GitHubService {
  fetch(request: Request): Promise<Response>;
  seed(config: GitHubSeedConfig): void;
  importFixture(repoFullName: string, bundle: Uint8Array, pins: NativeGitPins): Promise<void>;
  inspectGitHubState(): GitHubStateSnapshot;
  getGitHubActionLedger(): GitHubServiceAction[];
  replayDelivery(deliveryId: number): Promise<Pick<WebhookDelivery, "id" | "delivery_id" | "hook_id" | "event" | "action" | "status_code" | "success" | "redelivery_of" | "redelivery_count"> | undefined>;
  close(): Promise<void>;
}

function safeActor(request: Request, tokens: TokenMap, store: ReturnType<typeof createServer>["store"]): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  const basic = /^Basic\s/i.test(authorization)
    ? Buffer.from(authorization.replace(/^Basic\s+/i, ""), "base64").toString().split(":").slice(1).join(":")
    : null;
  const token = basic ?? authorization.replace(/^(Bearer|token)\s+/i, "").trim();
  const user = tokens.get(token);
  if (user?.installation) {
    const app = getGitHubStore(store).apps.findOneBy("app_id", user.installation.appId);
    return app ? `${app.slug}[bot]` : null;
  }
  if (user) return user.login;
  return null;
}

const actionFields = new Set([
  "event", "state", "commit_id", "body", "path", "line", "side", "position", "in_reply_to_id",
  "context", "name", "head_sha", "conclusion", "status", "expected_head_sha", "sha", "ref",
  "title", "draft", "merge_method", "merged", "merged_by", "number", "pull_number", "review_id",
  "id", "root_id", "root_comment_id", "review_comment_id",
]);

function actionFacts(value: unknown, secrets: readonly string[] = []): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(input)) {
    if (key === "comments" && Array.isArray(entry)) {
      result.comments = entry.flatMap((comment) => {
        if (!comment || typeof comment !== "object" || Array.isArray(comment)) return [];
        const safe = Object.fromEntries(Object.entries(comment as Record<string, unknown>)
          .filter(([name]) => actionFields.has(name))
          .map(([name, item]) => [name, redact(item, secrets)]));
        return [safe];
      });
    } else if (actionFields.has(key) && (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean" || entry === null)) {
      result[key] = redact(entry, secrets);
    }
  }
  return Object.keys(result).length ? result : undefined;
}

function redact<T>(value: T, secrets: readonly string[]): T {
  if (typeof value === "string") {
    return secrets.reduce((text, secret) => secret ? text.split(secret).join("[REDACTED]") : text, value) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, secrets)])) as T;
  }
  return value;
}

function knownSecrets(store: ReturnType<typeof createServer>["store"], tokens: TokenMap): string[] {
  const gh = getGitHubStore(store);
  return [
    ...tokens.keys(),
    ...getRevokedTokens(store),
    ...gh.apps.all().flatMap((app) => [app.private_key, app.webhook_secret ?? ""]),
    ...gh.oauthApps.all().map((app) => app.client_secret),
    ...gh.webhooks.all().map((hook) => hook.config.secret ?? ""),
  ].filter((secret) => secret.length > 0);
}

function snapshot(store: ReturnType<typeof createServer>["store"]): GitHubStateSnapshot {
  const gh = getGitHubStore(store);
  const repositories = gh.repos.all().map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    private: repo.private,
    default_branch: repo.default_branch,
  })).sort((a, b) => a.id - b.id);
  const repositoryName = (id: number) => gh.repos.get(id)?.full_name ?? null;
  const userName = (id: number) => gh.users.get(id)?.login ?? null;
  return {
    repositories,
    pullRequests: gh.pullRequests.all().map((pr) => ({
      id: pr.id,
      number: pr.number,
      repository: repositoryName(pr.repo_id) ?? "",
      title: pr.title,
      state: pr.merged ? "merged" : pr.state,
      draft: pr.draft,
      author: userName(pr.user_id),
      head: { ref: pr.head_ref, sha: pr.head_sha, repository: repositoryName(pr.head_repo_id) },
      base: { ref: pr.base_ref, sha: pr.base_sha, repository: repositoryName(pr.base_repo_id) },
    })).sort((a, b) => a.repository.localeCompare(b.repository) || a.number - b.number),
    reviews: gh.reviews.all().map((review) => ({
      id: review.id,
      number: review.pull_number,
      repository: repositoryName(review.repo_id) ?? "",
      author: userName(review.user_id),
      state: review.state,
      commit_id: review.commit_id,
      body: review.body,
    })).sort((a, b) => a.id - b.id),
    comments: gh.comments.all().filter((comment) => comment.comment_type === "review" || comment.comment_type === "issue").map((comment) => ({
      id: comment.id,
      number: comment.pull_number ?? comment.issue_number,
      repository: repositoryName(comment.repo_id) ?? "",
      author: userName(comment.user_id),
      body: comment.body,
      in_reply_to_id: comment.in_reply_to_id,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      commit_id: comment.commit_sha,
    })).sort((a, b) => a.id - b.id),
    checks: gh.checkRuns.all().map((check) => ({
      id: check.id,
      repository: repositoryName(check.repo_id) ?? "",
      name: check.name,
      head_sha: check.head_sha,
      status: check.status,
      conclusion: check.conclusion,
      app_id: check.app_id,
    })).sort((a, b) => a.id - b.id),
    statuses: gh.commitStatuses.all().map((status) => ({
      id: status.id,
      repository: repositoryName(status.repo_id) ?? "",
      sha: status.sha,
      context: status.context,
      state: status.state,
      description: status.description,
    })).sort((a, b) => a.id - b.id),
    protections: gh.branchProtections.all().map((protection) => ({
      repository: repositoryName(protection.repo_id) ?? "",
      branch: protection.branch_name,
      approving_reviews: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
      required_contexts: protection.required_status_checks?.contexts ?? [],
      required_checks: protection.required_status_checks?.checks ?? (protection.required_status_checks?.contexts ?? []).map((context) => ({ context, app_id: null })),
    })).sort((a, b) => a.repository.localeCompare(b.repository) || a.branch.localeCompare(b.branch)),
  };
}

export function createGitHubService(options: GitHubServiceOptions = {}): GitHubService {
  const seedConfig = { ...(options.seed ?? {}), strict_scopes: true };
  const nativeGit = createNativeGitStore();
  const plugin: ServicePlugin = {
    ...githubPlugin,
    register(app, store, webhooks, baseUrl, tokenMap) {
      nativeGit.attach(store);
      store.setData("github.native_git", true);
      registerNativeGitPolicy(app, store);
      githubPlugin.register(app, store, webhooks, baseUrl, tokenMap);
      smartHttpRoutes({ app, store, webhooks, baseUrl, tokenMap });
    },
  };
  let server: ReturnType<typeof createServer> | undefined;
  server = createServer(plugin, {
    baseUrl: options.baseUrl,
    appKeyResolver: (appId) => (server ? createAppKeyResolver(server.store)(appId) : null),
  });
  const githubServer = server;
  githubPlugin.seed?.(githubServer.store, githubServer.baseUrl);
  seedFromConfig(githubServer.store, githubServer.baseUrl, seedConfig);
  for (const [token, user] of Object.entries(seedConfig.tokens ?? {})) {
    const seededUser = getGitHubStore(githubServer.store).users.findOneBy("login", user.login);
    if (!seededUser) throw new Error(`Token user ${user.login} is not seeded`);
    githubServer.tokenMap.set(token, {
      login: user.login,
      id: seededUser.id,
      scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
    });
  }
  let sequence = 0;
  const actions: GitHubServiceAction[] = [];
  const importedRepos = new Set<string>();
  const secretValues = () => knownSecrets(githubServer.store, githubServer.tokenMap);
  let requestQueue = Promise.resolve();
  const stopObservingDeliveries = githubServer.webhooks.observeDeliveries((delivery) => {
    const payload = delivery.payload && typeof delivery.payload === "object"
      ? delivery.payload as Record<string, unknown>
      : {};
    actions.push({
      sequence: ++sequence,
      deliverySequence: delivery.id,
      type: "webhook",
      event: delivery.event,
      action: delivery.action,
      deliveryId: delivery.delivery_id,
      redeliveryOf: delivery.redelivery_of,
      successful: delivery.success,
      status: delivery.status_code ?? undefined,
      before: typeof payload.before === "string" ? redact(payload.before, secretValues()) as string : undefined,
      after: typeof payload.after === "string" ? redact(payload.after, secretValues()) as string : undefined,
    });
  });
  const fetch = async (request: Request): Promise<Response> => {
    let release!: () => void;
    const previous = requestQueue;
    requestQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await fetchSerial(request);
    } finally {
      release();
    }
  };
  const fetchSerial = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    let decodedPath = url.pathname;
    try {
      decodedPath = decodeURIComponent(url.pathname);
    } catch {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (decodedPath === "/_emulate" || decodedPath.startsWith("/_emulate/")) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const method = request.method.toUpperCase();
    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
    let requestFacts: Record<string, unknown> | undefined;
    if (mutating && request.headers.get("Content-Type")?.includes("application/json")) {
      try {
      requestFacts = actionFacts(await request.clone().json(), secretValues());
      } catch {
        requestFacts = undefined;
      }
    }
    const requestAction: GitHubServiceAction | undefined = mutating ? {
      sequence: ++sequence,
      type: "request",
      method,
      path: decodedPath,
      actor: safeActor(request, githubServer.tokenMap, githubServer.store),
    } : undefined;
    const response = await githubServer.app.fetch(request);
    if (mutating) {
      const success = response.status < 400;
      let result: Record<string, unknown> | undefined;
      if (success && response.headers.get("Content-Type")?.includes("application/json")) {
        try {
          result = actionFacts(await response.clone().json(), secretValues());
        } catch {
          result = undefined;
        }
      }
      Object.assign(requestAction!, {
        status: response.status,
        successful: success,
        actor: response.status === 401 || response.status === 403 ? null : requestAction!.actor,
        ...(requestFacts ? { input: requestFacts } : {}),
        ...(result ? { result } : {}),
      });
      actions.push(requestAction!);
    }
    return response;
  };
  return {
    fetch,
    seed(config) {
      if (importedRepos.size) throw new Error("Cannot change seed after importing a native Git fixture");
      const strictConfig = { ...config, strict_scopes: true };
      seedFromConfig(githubServer.store, githubServer.baseUrl, strictConfig);
      for (const [token, user] of Object.entries(strictConfig.tokens ?? {})) {
        const seededUser = getGitHubStore(githubServer.store).users.findOneBy("login", user.login);
        if (!seededUser) throw new Error(`Token user ${user.login} is not seeded`);
        githubServer.tokenMap.set(token, {
          login: user.login,
          id: seededUser.id,
          scopes: user.scopes ?? ["repo", "user", "admin:org", "admin:repo_hook"],
        });
      }
    },
    async importFixture(repoFullName, bundle, pins) {
      if (importedRepos.has(repoFullName)) throw new Error(`Fixture repository ${repoFullName} was already imported`);
      const repo = getGitHubStore(githubServer.store).repos.findOneBy("full_name", repoFullName);
      if (!repo) throw new Error(`Fixture repository ${repoFullName} is not seeded`);
      await nativeGit.importBundle(repoFullName, bundle, pins, repo.default_branch);
      await projectNativeGit(repoFullName, githubServer.store);
      importedRepos.add(repoFullName);
    },
    inspectGitHubState() {
      return redact(structuredClone(snapshot(githubServer.store)), secretValues());
    },
    getGitHubActionLedger() {
      return structuredClone(actions).sort((a, b) => a.sequence - b.sequence);
    },
    async replayDelivery(deliveryId) {
      const delivery = await githubServer.webhooks.redeliver(deliveryId);
      if (!delivery) return undefined;
      return {
        id: delivery.id,
        delivery_id: delivery.delivery_id,
        hook_id: delivery.hook_id,
        event: delivery.event,
        action: delivery.action,
        status_code: delivery.status_code,
        success: delivery.success,
        redelivery_of: delivery.redelivery_of,
        redelivery_count: delivery.redelivery_count,
      };
    },
    async close() {
      stopObservingDeliveries();
      await nativeGit.close();
    },
  };
}
