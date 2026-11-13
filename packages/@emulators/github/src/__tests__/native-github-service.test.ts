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

async function makeFixture() {
  const root = await mkdtemp(join(tmpdir(), "github-native-service-test-"));
  roots.push(root);
  const source = join(root, "source");
  execFileSync("git", ["init", "-b", "main", source]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fixture Author"]);
  execFileSync("git", ["-C", source, "config", "user.email", "fixture@example.com"]);
  await writeFile(join(source, "README.md"), "fixture\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "fixture base"]);
  const baseSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(join(source, "review.txt"), "line to review\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "prepared review"]);
  const headSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", source, "branch", "review"]);
  execFileSync("git", ["-C", source, "update-ref", "refs/heads/main", baseSha]);
  const bundlePath = join(root, "fixture.bundle");
  execFileSync("git", ["-C", source, "bundle", "create", bundlePath, "--all"]);
  return { root, bundle: await readFile(bundlePath), baseSha, headSha };
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
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
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
});
