import type { AppEnv, Context, RouteContext } from "@emulators/core";
import { ApiError } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { getNativeGitStore } from "../native-git.js";
import { lookupRepo } from "../helpers.js";
import { formatPullRequest, formatRepo, formatUser, timestamp } from "../helpers.js";
import { assertRepoContentsRead, assertRepoContentsWrite, ownerLoginOf } from "../route-helpers.js";
import { projectNativeGit } from "../native-projection.js";
import { formatCommitItem } from "../git-helpers.js";

export function smartHttpRoutes(context: RouteContext): void {
  const { app, store, webhooks, baseUrl } = context;
  const gh = getGitHubStore(store);
  const nativeGit = getNativeGitStore(store);

  const handle = async (c: Context<AppEnv>, endpoint: string) => {
    const url = new URL(c.req.url);
    const owner = c.req.param("owner")!;
    const repoSegment = c.req.param("repo")!;
    if (!repoSegment.endsWith(".git")) return new Response("Not Found", { status: 404 });
    const name = repoSegment.slice(0, -4);
    if (/%(?:2f|2e|00|5c)/i.test(url.pathname)) return new Response("Not Found", { status: 404 });
    const fullName = `${owner}/${name}`;
    const repo = lookupRepo(gh, owner, name);
    if (!repo) return new Response("Not Found", { status: 404 });
    if (!nativeGit.hasRepo(fullName)) throw new ApiError(503, "Native Git repository is not initialized");

    if (store.getData<boolean>("github.strict_scopes") === true && !c.get("authToken") && !c.get("authApp")) {
      return new Response(JSON.stringify({ message: "Bad credentials" }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": 'Basic realm="GitHub"' },
      });
    }

    const requestedService = url.searchParams.get("service");
    const receive = endpoint === "git-receive-pack" || (endpoint === "info/refs" && requestedService === "git-receive-pack");
    if (endpoint === "info/refs" && requestedService !== "git-upload-pack" && requestedService !== "git-receive-pack") {
      return new Response("Not Found", { status: 404 });
    }
    const scopes = c.get("authScopes") ?? [];
    if (!c.get("authUser")?.installation) {
      const canRead = !repo.private || scopes.includes("repo") || scopes.includes("public_repo") || scopes.includes("contents:read") || scopes.includes("contents:write");
      const canWrite = scopes.includes("repo") || scopes.includes("public_repo") || scopes.includes("contents:write");
      if ((receive && !canWrite) || (!receive && !canRead)) {
        throw new ApiError(403, "Resource not accessible by token");
      }
    }
    if (receive) assertRepoContentsWrite(gh, c.get("authUser"), repo);
    else assertRepoContentsRead(gh, c.get("authUser"), repo);

    const method = c.req.method.toUpperCase();
    if ((endpoint === "info/refs" && method !== "GET") || (endpoint !== "info/refs" && method !== "POST")) {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: endpoint === "info/refs" ? "GET" : "POST" } });
    }
    const contentType = c.req.header("Content-Type") ?? "";
    const expectedContentType = receive ? "application/x-git-receive-pack-request" : "application/x-git-upload-pack-request";
    if (method === "POST" && contentType.split(";")[0]!.trim().toLowerCase() !== expectedContentType) {
      throw new ApiError(415, "Unsupported Git smart HTTP content type");
    }

    const before = receive ? await nativeGit.refs(fullName) : undefined;
    const body = method === "POST" ? new Uint8Array(await c.req.arrayBuffer()) : new Uint8Array();
    const response = await nativeGit.httpBackend(
      fullName,
      url.pathname,
      method,
      url.searchParams.toString(),
      contentType,
      c.req.header("Git-Protocol"),
      body,
      c.get("authUser")?.login ?? c.get("authApp")?.slug ?? "anonymous",
    );
    if (receive && before && response.ok) {
      const after = await nativeGit.refs(fullName);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        await projectNativeGit(fullName, store);
        const repoOwner = ownerLoginOf(gh, repo);
        const sender = c.get("authUser")
          ? gh.users.findOneBy("login", c.get("authUser")!.login)
          : c.get("authApp")
            ? gh.users.findOneBy("login", `${c.get("authApp")!.slug}[bot]`)
            : undefined;
        for (const ref of new Set([...Object.keys(before), ...Object.keys(after)])) {
          if (before[ref] === after[ref]) continue;
          const previous = before[ref] ?? "0".repeat(after[ref]?.length ?? 40);
          const current = after[ref] ?? "0".repeat(before[ref]?.length ?? 40);
          const branchName = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
          if (branchName && sender) {
            await webhooks.dispatch(
              "push",
              undefined,
              {
                ref: `refs/heads/${branchName}`,
                before: previous,
                after: current,
                created: !before[ref] && !!after[ref],
                deleted: !!before[ref] && !after[ref],
                forced: false,
                commits: [],
                head_commit: after[ref]
                  ? (() => {
                      const commit = gh.commits.findBy("repo_id", repo.id).find((candidate) => candidate.sha === after[ref]);
                      return commit ? formatCommitItem(gh, repo, commit, baseUrl) : null;
                    })()
                  : null,
                repository: formatRepo(repo, gh, baseUrl),
                sender: formatUser(sender, baseUrl),
              },
              repoOwner,
              repo.name,
            );
          }
          if (!branchName || !after[ref] || !sender) continue;
          for (const pr of gh.pullRequests.findBy("repo_id", repo.id)) {
            if (pr.state !== "open" || pr.head_repo_id !== repo.id || pr.head_ref !== branchName || pr.head_sha === after[ref]) {
              continue;
            }
            const commits = await nativeGit.history(fullName, pr.base_sha, after[ref]);
            const files = await nativeGit.changedFiles(fullName, pr.base_sha, after[ref]);
            gh.pullRequests.update(pr.id, {
              head_sha: after[ref]!,
              commits: commits.length,
              additions: files.reduce((sum, file) => sum + file.additions, 0),
              deletions: files.reduce((sum, file) => sum + file.deletions, 0),
              changed_files: files.length,
              mergeable: null,
              mergeable_state: "unknown",
            });
            const updated = gh.pullRequests.get(pr.id)!;
            await webhooks.dispatch(
              "pull_request",
              "synchronize",
              {
                action: "synchronize",
                number: pr.number,
                before: pr.head_sha,
                after: after[ref],
                pull_request: formatPullRequest(updated, gh, baseUrl),
                repository: formatRepo(repo, gh, baseUrl),
                sender: formatUser(sender, baseUrl),
              },
              repoOwner,
              repo.name,
            );
          }
        }
        const pushedAt = timestamp();
        gh.repos.update(repo.id, { pushed_at: pushedAt });
      }
    }
    return response;
  };

  app.get("/:owner/:repo{[^/]+\\.git}/info/refs", (c) => handle(c, "info/refs"));
  app.post("/:owner/:repo{[^/]+\\.git}/git-upload-pack", (c) => handle(c, "git-upload-pack"));
  app.post("/:owner/:repo{[^/]+\\.git}/git-receive-pack", (c) => handle(c, "git-receive-pack"));
}
