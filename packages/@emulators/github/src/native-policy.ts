import type { Hono, Store } from "@emulators/core";
import { ApiError } from "@emulators/core";
import { getNativeGitStore } from "./native-git.js";
import { getGitHubStore } from "./store.js";
import { lookupRepo } from "./helpers.js";
import { ownerLoginOf } from "./route-helpers.js";

const NATIVE_READ_PATHS = /\/(?:git(?:\/|$)|branches(?:\/|$)|contents(?:\/|$)|readme(?:\/|$)|commits(?:\/|$)|compare(?:\/|$))/;
const NATIVE_PR_GIT_READ_PATH = /\/pulls\/[^/]+\/(?:files|commits)(?:\/|$)/;
const NATIVE_WRITE_PATH = /\/(?:git(?:\/|$)|contents(?:\/|$))/;
const NATIVE_PR_MERGE_PATH = /\/pulls\/[^/]+\/merge(?:\/|$)/;
const NATIVE_PR_UPDATE_PATH = /\/pulls\/[^/]+\/update-branch(?:\/|$)/;
const PULLS_PATH = /^\/pulls(?:\/([1-9]\d*))?$/;

export function registerNativeGitPolicy(app: Hono, store: Store): void {
  app.use("*", async (c, next) => {
    if (store.getData<boolean>("github.native_git") !== true) return next();
    const url = new URL(c.req.url);
    const repoPath = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoPath) return next();
    if (repoPath[1]!.includes("%") || repoPath[2]!.includes("%")) return new Response("Not Found", { status: 404 });
    const fullName = `${decodeURIComponent(repoPath[1]!)}\/${decodeURIComponent(repoPath[2]!)}`;
    const path = repoPath[3] ?? "";
    const method = c.req.method.toUpperCase();
    const nativeRead = method === "GET" && (NATIVE_READ_PATHS.test(path) || NATIVE_PR_GIT_READ_PATH.test(path));
    const nativeWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method) && (NATIVE_WRITE_PATH.test(path) || NATIVE_PR_MERGE_PATH.test(path) || NATIVE_PR_UPDATE_PATH.test(path));
    const pullMutation = (method === "POST" || method === "PATCH") && PULLS_PATH.test(path);
    if (!nativeRead && !nativeWrite && !pullMutation) return next();
    const nativeGit = getNativeGitStore(store);
    if (!nativeGit.hasRepo(fullName)) throw new ApiError(503, "Native Git repository is not initialized");
    if (nativeWrite) throw new ApiError(501, "Use Git smart HTTP to write repository objects and refs");
    if (pullMutation) {
      let body: Record<string, unknown>;
      try {
        const value: unknown = await c.req.raw.clone().json();
        body = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
      } catch {
        return next();
      }
      const gh = getGitHubStore(store);
      const repo = lookupRepo(gh, decodeURIComponent(repoPath[1]!), decodeURIComponent(repoPath[2]!));
      if (!repo) return next();

      if (method === "POST") {
        const headRaw = typeof body.head === "string" ? body.head.trim() : "";
        const baseRaw = typeof body.base === "string" ? body.base.trim() : "";
        if (!headRaw || !baseRaw) return next();
        const headSeparator = headRaw.indexOf(":");
        const headOwner = headSeparator === -1 ? ownerLoginOf(gh, repo) : headRaw.slice(0, headSeparator).trim();
        const headRef = headSeparator === -1 ? headRaw : headRaw.slice(headSeparator + 1).trim();
        const baseOwner = ownerLoginOf(gh, repo);
        const headRepo = headOwner === baseOwner
          ? repo
          : gh.repos.all().find((candidate) => {
              if (candidate.forked_from_id !== repo.id) return false;
              return ownerLoginOf(gh, candidate) === headOwner;
            });
        if (!headRef || !headRepo || !nativeGit.hasRepo(headRepo.full_name) ||
          !(await nativeGit.hasBranch(headRepo.full_name, headRef)) ||
          !(await nativeGit.hasBranch(repo.full_name, baseRaw))) {
          throw new ApiError(422, "Validation failed");
        }
      } else if (body.base !== undefined && body.base !== null) {
        const baseRef = typeof body.base === "string" ? body.base.trim() : "";
        const pullNumber = Number(PULLS_PATH.exec(path)?.[1]);
        const pull = gh.pullRequests.findBy("repo_id", repo.id).find((candidate) => candidate.number === pullNumber);
        if (!pull || !baseRef || !(await nativeGit.hasBranch(repo.full_name, baseRef))) {
          throw new ApiError(422, "Validation failed");
        }
      }
    }
    return next();
  });
}
