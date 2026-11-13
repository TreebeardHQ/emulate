import type { Hono, Store } from "@emulators/core";
import { ApiError } from "@emulators/core";
import { getNativeGitStore } from "./native-git.js";

const NATIVE_READ_PATHS = /\/(?:git(?:\/|$)|branches(?:\/|$)|contents(?:\/|$)|readme(?:\/|$)|commits(?:\/|$)|compare(?:\/|$))/;
const NATIVE_PR_GIT_READ_PATH = /\/pulls\/[^/]+\/(?:files|commits)(?:\/|$)/;
const NATIVE_WRITE_PATH = /\/(?:git(?:\/|$)|contents(?:\/|$))/;
const NATIVE_PR_MERGE_PATH = /\/pulls\/[^/]+\/merge(?:\/|$)/;
const NATIVE_PR_UPDATE_PATH = /\/pulls\/[^/]+\/update-branch(?:\/|$)/;

export function registerNativeGitPolicy(app: Hono, store: Store): void {
  app.use("*", async (c, next) => {
    if (store.getData<boolean>("github.native_git") !== true) return next();
    const url = new URL(c.req.url);
    const repoPath = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (!repoPath) return next();
    if (repoPath[1]!.includes("%") || repoPath[2]!.includes("%")) return new Response("Not Found", { status: 404 });
    if (repoPath[1]!.includes("%") || repoPath[2]!.includes("%")) return new Response("Not Found", { status: 404 });
    const fullName = `${decodeURIComponent(repoPath[1]!)}\/${decodeURIComponent(repoPath[2]!)}`;
    const path = repoPath[3] ?? "";
    const method = c.req.method.toUpperCase();
    const nativeRead = method === "GET" && (NATIVE_READ_PATHS.test(path) || NATIVE_PR_GIT_READ_PATH.test(path));
    const nativeWrite = ["POST", "PUT", "PATCH", "DELETE"].includes(method) && (NATIVE_WRITE_PATH.test(path) || NATIVE_PR_MERGE_PATH.test(path) || NATIVE_PR_UPDATE_PATH.test(path));
    if (!nativeRead && !nativeWrite) return next();
    const nativeGit = getNativeGitStore(store);
    if (!nativeGit.hasRepo(fullName)) throw new ApiError(503, "Native Git repository is not initialized");
    if (nativeWrite) throw new ApiError(501, "Use Git smart HTTP to write repository objects and refs");
    return next();
  });
}
