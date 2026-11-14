import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createGitHubService } from "../index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeFixture(advanceBase = false, literalFilenames = false) {
  const root = await mkdtemp(join(tmpdir(), "github-native-service-test-"));
  roots.push(root);
  const source = join(root, "source");
  execFileSync("git", ["init", "-b", "main", source]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fixture Author"]);
  execFileSync("git", ["-C", source, "config", "user.email", "fixture@example.com"]);
  await writeFile(join(source, "README.md"), "fixture\n");
  await writeFile(join(source, "old.txt"), "before rename\nshared one\nshared two\nshared three\n");
  await writeFile(join(source, "obsolete.txt"), "obsolete at merge base\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "fixture base"]);
  const baseSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", source, "switch", "-c", "side"]);
  await writeFile(join(source, "side.txt"), "side one\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "side one"]);
  await writeFile(join(source, "side.txt"), "side one\nside two\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "side two"]);
  const sideSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", source, "switch", "-c", "review", "main"]);
  await writeFile(join(source, "review.txt"), "line to review\n");
  if (literalFilenames) {
    await writeFile(join(source, "a*.txt"), "literal wildcard name\n");
    await writeFile(join(source, "abc.txt"), "glob match one\nglob match two\nglob match three\n");
  }
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "prepared review"]);
  execFileSync("git", ["-C", source, "merge", "--no-ff", "side", "-m", "merge side"]);
  execFileSync("git", ["-C", source, "mv", "old.txt", "renamed.txt"]);
  await writeFile(join(source, "renamed.txt"), "after rename\nshared one\nshared two\nshared three\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "rename fixture file"]);
  if (advanceBase) {
    execFileSync("git", ["-C", source, "rm", "obsolete.txt"]);
    execFileSync("git", ["-C", source, "commit", "-m", "remove obsolete file"]);
  }
  const headSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (advanceBase) {
    execFileSync("git", ["-C", source, "switch", "main"]);
    await writeFile(join(source, "obsolete.txt"), "obsolete changed after merge base\n");
    execFileSync("git", ["-C", source, "add", "."]);
    execFileSync("git", ["-C", source, "commit", "-m", "advance base independently"]);
  }
  const baseTipSha = execFileSync("git", ["-C", source, "rev-parse", "main"], { encoding: "utf8" }).trim();
  const bundlePath = join(root, "fixture.bundle");
  execFileSync("git", ["-C", source, "bundle", "create", bundlePath, "--all"]);
  return { root, bundle: await readFile(bundlePath), baseSha: baseTipSha, mergeBaseSha: baseSha, headSha, sideSha };
}

describe("native GitHub service", () => {
  it("enforces strict smart HTTP auth and keeps Git pushes coherent with REST PR state", async () => {
    const fixture = await makeFixture();
    const service = createGitHubService({
      seed: {
        users: [{ login: "fixture-user", name: "Fixture User", email: "fixture@example.com" }],
        tokens: {
          "fixture-token": { login: "fixture-user", scopes: ["repo"] },
          "read-only-token": { login: "fixture-user", scopes: ["contents:read"] },
        },
        repos: [
          { owner: "fixture-user", name: "project", private: true, default_branch: "main", auto_init: false },
          { owner: "fixture-user", name: "uninitialized", private: true, default_branch: "main", auto_init: false },
        ],
      },
    });
    let server: ReturnType<typeof createServer> | undefined;
    try {
      await service.importFixture("fixture-user/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/side": fixture.sideSha, "refs/heads/review": fixture.headSha },
      });
      const url = "http://localhost/fixture-user/project.git/info/refs?service=git-upload-pack";
      const missing = await service.fetch(new Request(url));
      expect(missing.status).toBe(401);
      expect(missing.headers.get("WWW-Authenticate")).toContain("Basic");
      const unknown = await service.fetch(
        new Request(url, { headers: { Authorization: `Basic ${Buffer.from("fixture-user:unknown-token").toString("base64")}` } }),
      );
      expect(unknown.status).toBe(401);
      const invalidNativeRead = await service.fetch(new Request(
        "http://localhost/repos/fixture-user/uninitialized/git/ref/heads/main",
        { headers: { Authorization: "Bearer unknown-token" } },
      ));
      expect(invalidNativeRead.status).toBe(401);
      const invalidNativeWrite = await service.fetch(new Request(
        "http://localhost/repos/fixture-user/project/contents/file.txt",
        {
          method: "POST",
          headers: { Authorization: "Bearer unknown-token", "Content-Type": "application/json" },
          body: JSON.stringify({ message: "unauthorized" }),
        },
      ));
      expect(invalidNativeWrite.status).toBe(401);
      const missingNativeRepoPull = await service.fetch(new Request("http://localhost/repos/fixture-user/uninitialized/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Missing native repository", head: "main", base: "main" }),
      }));
      expect(missingNativeRepoPull.status).toBe(503);
      await service.fetch(new Request("http://localhost/repos/fixture-user/project/issues/fixture-token/comments", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ body: "fixture-token" }),
      }));
      expect(JSON.stringify(service.getGitHubActionLedger())).not.toContain("fixture-token");
      const readOnlyWrite = await service.fetch(
        new Request("http://localhost/fixture-user/project.git/info/refs?service=git-receive-pack", {
          headers: { Authorization: "Bearer read-only-token" },
        }),
      );
      expect(readOnlyWrite.status).toBe(403);
      const branchesBefore = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/branches", { headers: { Authorization: "Bearer fixture-token" } }),
      );
      const branchSnapshot = await branchesBefore.text();
      const refsBefore = await service.fetch(new Request(url, { headers: { Authorization: "Bearer fixture-token" } }));
      const nativeRefSnapshot = Buffer.from(await refsBefore.arrayBuffer());
      const stateBeforeInvalidPrs = service.inspectGitHubState();
      const missingHead = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls", {
          method: "POST",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Missing head", head: "does-not-exist", base: "main" }),
        }),
      );
      expect(missingHead.status).toBe(422);
      const missingBase = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls", {
          method: "POST",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Missing base", head: "review", base: "does-not-exist" }),
        }),
      );
      expect(missingBase.status).toBe(422);
      expect(service.inspectGitHubState()).toEqual(stateBeforeInvalidPrs);
      const branchesAfter = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/branches", { headers: { Authorization: "Bearer fixture-token" } }),
      );
      expect(await branchesAfter.text()).toBe(branchSnapshot);
      const refsAfter = await service.fetch(new Request(url, { headers: { Authorization: "Bearer fixture-token" } }));
      expect(Buffer.from(await refsAfter.arrayBuffer())).toEqual(nativeRefSnapshot);
      const pullResponse = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls", {
          method: "POST",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Review fixture", head: "review", base: "main" }),
        }),
      );
      expect(pullResponse.status).toBe(201);
      const pull = await pullResponse.json() as { commits: number; additions: number; deletions: number; changed_files: number };
      const commitsResponse = await service.fetch(new Request(
        "http://localhost/repos/fixture-user/project/pulls/1/commits",
        { headers: { Authorization: "Bearer fixture-token" } },
      ));
      expect(commitsResponse.status).toBe(200);
      const prCommits = await commitsResponse.json() as Array<{ sha: string }>;
      expect(prCommits).toHaveLength(5);
      expect(prCommits.map((commit) => commit.sha)).toContain(fixture.sideSha);
      expect(prCommits.map((commit) => commit.sha)).toContain(fixture.headSha);
      expect(pull).toMatchObject({ commits: 5, additions: 4, deletions: 1, changed_files: 3 });
      const filesResponse = await service.fetch(new Request(
        "http://localhost/repos/fixture-user/project/pulls/1/files",
        { headers: { Authorization: "Bearer fixture-token" } },
      ));
      expect(filesResponse.status).toBe(200);
      const fileRows = await filesResponse.json() as Array<{ sha: string; patch?: string }>;
      const reviewFileSha = execFileSync("git", ["-C", `${fixture.root}/source`, "rev-parse", `${fixture.headSha}:review.txt`], { encoding: "utf8" }).trim();
      const sideFileSha = execFileSync("git", ["-C", `${fixture.root}/source`, "rev-parse", `${fixture.headSha}:side.txt`], { encoding: "utf8" }).trim();
      const renamedFileSha = execFileSync("git", ["-C", `${fixture.root}/source`, "rev-parse", `${fixture.headSha}:renamed.txt`], { encoding: "utf8" }).trim();
      expect(fileRows).toEqual(expect.arrayContaining([
        expect.objectContaining({ sha: reviewFileSha, filename: "review.txt", status: "added", additions: 1, deletions: 0, changes: 1 }),
        expect.objectContaining({ sha: sideFileSha, filename: "side.txt", status: "added", additions: 2, deletions: 0, changes: 2 }),
        expect.objectContaining({ sha: renamedFileSha, filename: "renamed.txt", previous_filename: "old.txt", status: "renamed", additions: 1, deletions: 1, changes: 2 }),
      ]));
      expect(fileRows.find((file) => file.sha === reviewFileSha)?.patch).toContain("@@ -0,0 +1 @@\n+line to review");
      expect(prCommits.map((commit) => commit.sha)).not.toContain(fixture.mergeBaseSha);
      const stateBeforeRetarget = service.inspectGitHubState();
      const missingRetarget = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls/1", {
          method: "PATCH",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({ base: "missing-base" }),
        }),
      );
      expect(missingRetarget.status).toBe(422);
      expect(service.inspectGitHubState()).toEqual(stateBeforeRetarget);
      const branchListAfterRetarget = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/branches", { headers: { Authorization: "Bearer fixture-token" } }),
      );
      expect(await branchListAfterRetarget.text()).toBe(branchSnapshot);
      const diffResponse = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls/1", {
          headers: { Authorization: "Bearer fixture-token", Accept: "application/vnd.github.v3.diff" },
        }),
      );
      expect(diffResponse.headers.get("Content-Type")).toContain("application/vnd.github.v3.diff");
      expect(await diffResponse.text()).toContain("diff --git a/review.txt b/review.txt");
      const invalidReview = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls/1/reviews", {
          method: "POST",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "COMMENT",
            commit_id: fixture.headSha,
            comments: [
              { path: "review.txt", line: 1, side: "RIGHT", body: "valid anchor first" },
              { path: "review.txt", line: 99, side: "RIGHT", body: "invalid anchor second" },
            ],
          }),
        }),
      );
      expect(invalidReview.status).toBe(422);
      const emptyReviews = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls/1/reviews", {
          headers: { Authorization: "Bearer fixture-token" },
        }),
      );
      expect(await emptyReviews.json()).toEqual([]);
      const validReview = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/pulls/1/reviews", {
          method: "POST",
          headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
          body: JSON.stringify({
            event: "COMMENT",
            commit_id: fixture.headSha,
            comments: [{ path: "review.txt", line: 1, side: "RIGHT", body: "valid inline comment" }],
          }),
        }),
      );
      expect(validReview.status).toBe(201);
      expect(service.inspectGitHubState().reviews[0]?.commit_id).toBe(fixture.headSha);

      server = createServer(async (incoming, outgoing) => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        const headers = new Headers();
        for (const [name, value] of Object.entries(incoming.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(", "));
          else if (value !== undefined) headers.set(name, value);
        }
        const init = {
          method: incoming.method,
          headers,
          ...(body.byteLength ? { body, duplex: "half" as const } : {}),
        } as RequestInit & { duplex?: "half" };
        const request = new Request(`http://127.0.0.1${incoming.url ?? "/"}`, init);
        const response = await service.fetch(request);
        outgoing.writeHead(response.status, Object.fromEntries(response.headers));
        outgoing.end(Buffer.from(await response.arrayBuffer()));
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
      const remote = `http://127.0.0.1:${address.port}/fixture-user/project.git`;
      const clone = join(fixture.root, "clone");
      const basic = Buffer.from("fixture-user:fixture-token").toString("base64");
      await execFileAsync("git", ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "clone", remote, clone], { timeout: 10000 });
      await execFileAsync("git", ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "-C", clone, "fetch", "origin", "refs/heads/review:refs/remotes/origin/review"], { timeout: 10000 });
      await execFileAsync("git", ["-C", clone, "checkout", "-b", "review", "refs/remotes/origin/review"]);
      await writeFile(join(clone, "follow-up.txt"), "pushed after review\n");
      execFileSync("git", ["-C", clone, "add", "."]);
      execFileSync("git", ["-C", clone, "commit", "-m", "push review update"]);
      await execFileAsync("git", ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "-C", clone, "push", "origin", "HEAD:refs/heads/review"], { timeout: 10000 });
      const pushedSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

      const refResponse = await service.fetch(
        new Request("http://localhost/repos/fixture-user/project/git/ref/heads/review", {
          headers: { Authorization: "Bearer fixture-token" },
        }),
      );
      expect(refResponse.status).toBe(200);
      expect(await refResponse.json()).toMatchObject({ object: { sha: pushedSha } });
      expect(service.inspectGitHubState().pullRequests[0]?.head.sha).toBe(pushedSha);
      expect(service.inspectGitHubState().reviews[0]?.commit_id).toBe(fixture.headSha);
      const readMergeState = async () => {
        const response = await service.fetch(
          new Request("http://localhost/graphql", {
            method: "POST",
            headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
            body: JSON.stringify({
              query: "query MergeGate($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { mergeStateStatus baseRef { branchProtectionRule { requiredApprovingReviewCount } } } } }",
              variables: { owner: "fixture-user", repo: "project", number: 1 },
            }),
          }),
        );
        expect(response.status).toBe(200);
        return response.json();
      };
      expect(await readMergeState()).toMatchObject({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN" } } } });

      execFileSync("git", ["-C", clone, "checkout", "main"]);
      await writeFile(join(clone, "README.md"), "base edit\n");
      execFileSync("git", ["-C", clone, "add", "."]);
      execFileSync("git", ["-C", clone, "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "commit", "-m", "update base"]);
      await execFileAsync("git", ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "-C", clone, "push", "origin", "HEAD:refs/heads/main"], { timeout: 10000 });
      expect(await readMergeState()).toMatchObject({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN" } } } });

      execFileSync("git", ["-C", clone, "checkout", "review"]);
      await writeFile(join(clone, "README.md"), "head edit\n");
      execFileSync("git", ["-C", clone, "add", "."]);
      execFileSync("git", ["-C", clone, "-c", "user.name=Fixture Author", "-c", "user.email=fixture@example.com", "commit", "-m", "conflict with base"]);
      const conflictedSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      await execFileAsync("git", ["-c", `http.extraHeader=Authorization: Basic ${basic}`, "-C", clone, "push", "origin", "HEAD:refs/heads/review"], { timeout: 10000 });
      expect(service.inspectGitHubState().pullRequests[0]?.head.sha).toBe(conflictedSha);
      expect(await readMergeState()).toMatchObject({ data: { repository: { pullRequest: { mergeStateStatus: "DIRTY" } } } });
    } finally {
      if (server?.listening) {
        server.closeIdleConnections();
        await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
      }
      await service.close();
    }
  }, 20_000);

  it("recomputes native PR metadata when the base branch changes", async () => {
    const fixture = await makeFixture();
    const service = createGitHubService({
      seed: {
        users: [{ login: "fixture-user", name: "Fixture User", email: "fixture@example.com" }],
        tokens: { "fixture-token": { login: "fixture-user", scopes: ["repo"] } },
        repos: [{ owner: "fixture-user", name: "project", private: true, default_branch: "main", auto_init: false }],
      },
    });
    try {
      await service.importFixture("fixture-user/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/side": fixture.sideSha, "refs/heads/review": fixture.headSha },
      });
      const pull = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Retarget test", head: "review", base: "main" }),
      }));
      expect(pull.status).toBe(201);
      const initial = await pull.json() as { commits: number; additions: number; deletions: number; changed_files: number };
      expect(initial).toMatchObject({ commits: 5, additions: 4, deletions: 1, changed_files: 3 });

      const retarget = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls/1", {
        method: "PATCH",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ base: "side" }),
      }));
      expect(retarget.status).toBe(200);
      const updated = await retarget.json() as { commits: number; additions: number; deletions: number; changed_files: number };
      expect(updated).toMatchObject({ commits: 3, additions: 2, deletions: 1, changed_files: 2 });
      const filesResponse = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls/1/files", {
        headers: { Authorization: "Bearer fixture-token" },
      }));
      const files = await filesResponse.json() as Array<{ filename: string }>;
      expect(files.map((file) => file.filename).sort()).toEqual(["renamed.txt", "review.txt"]);
    } finally {
      await service.close();
    }
  }, 20_000);

  it("uses the merge-base blob when a PR deletes a file changed independently on base", async () => {
    const fixture = await makeFixture(true);
    const service = createGitHubService({
      seed: {
        users: [{ login: "fixture-user", name: "Fixture User", email: "fixture@example.com" }],
        tokens: { "fixture-token": { login: "fixture-user", scopes: ["repo"] } },
        repos: [{ owner: "fixture-user", name: "project", private: true, default_branch: "main", auto_init: false }],
      },
    });
    try {
      await service.importFixture("fixture-user/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
      });
      const pull = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Diverged delete", head: "review", base: "main" }),
      }));
      expect(pull.status).toBe(201);
      const files = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls/1/files", {
        headers: { Authorization: "Bearer fixture-token" },
      }));
      expect(files.status).toBe(200);
      const rows = await files.json() as Array<Record<string, unknown>>;
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({
        sha: execFileSync("git", ["-C", `${fixture.root}/source`, "rev-parse", `${fixture.mergeBaseSha}:obsolete.txt`], { encoding: "utf8" }).trim(),
        filename: "obsolete.txt",
        status: "removed",
        additions: 0,
        deletions: 1,
      })]));
    } finally {
      await service.close();
    }
  }, 20_000);

  it("treats wildcard characters in changed file names literally", async () => {
    const fixture = await makeFixture(false, true);
    const service = createGitHubService({
      seed: {
        users: [{ login: "fixture-user", name: "Fixture User", email: "fixture@example.com" }],
        tokens: { "fixture-token": { login: "fixture-user", scopes: ["repo"] } },
        repos: [{ owner: "fixture-user", name: "project", private: true, default_branch: "main", auto_init: false }],
      },
    });
    try {
      await service.importFixture("fixture-user/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
      });
      const pull = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls", {
        method: "POST",
        headers: { Authorization: "Bearer fixture-token", "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Literal filename", head: "review", base: "main" }),
      }));
      expect(pull.status).toBe(201);
      const filesResponse = await service.fetch(new Request("http://localhost/repos/fixture-user/project/pulls/1/files", {
        headers: { Authorization: "Bearer fixture-token" },
      }));
      const files = await filesResponse.json() as Array<{ filename: string; additions: number; patch?: string }>;
      expect(files.find((file) => file.filename === "a*.txt")).toMatchObject({ additions: 1 });
      expect(files.find((file) => file.filename === "a*.txt")?.patch).toContain("+literal wildcard name");
      expect(files.find((file) => file.filename === "a*.txt")?.patch).not.toContain("abc.txt");
    } finally {
      await service.close();
    }
  }, 20_000);

  it("cancels an unfinished receive-pack before draining service operations", async () => {
    const fixture = await makeFixture();
    const service = createGitHubService({
      seed: {
        users: [{ login: "fixture-user", name: "Fixture User", email: "fixture@example.com" }],
        tokens: { "fixture-token": { login: "fixture-user", scopes: ["repo"] } },
        repos: [{ owner: "fixture-user", name: "project", private: true, default_branch: "main", auto_init: false }],
      },
    });
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    try {
      await service.importFixture("fixture-user/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
      });
      const upload = service.fetch(new Request("http://localhost/fixture-user/project.git/git-receive-pack", {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from("fixture-user:fixture-token").toString("base64")}`,
          "Content-Type": "application/x-git-receive-pack-request",
        },
        body: new ReadableStream<Uint8Array>({ start(controller) { bodyController = controller; } }),
        duplex: "half",
      }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await Promise.race([upload.then(() => "settled", () => "settled"), new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 0))])).toBe("pending");

      const close = service.close();
      const closed = await Promise.race([
        close.then(() => true, () => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1000)),
      ]);
      if (!closed) bodyController?.close();
      await close;
      expect(closed).toBe(true);
      expect((await upload).status).toBeGreaterThanOrEqual(500);
    } finally {
      try { bodyController?.close(); } catch { /* already canceled by shutdown */ }
      await service.close();
    }
  }, 10_000);
});
