import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { seedFromConfig } from "../index.js";
import { createNativeGitStore } from "../native-git.js";
import { projectNativeGit } from "../native-projection.js";

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const bunAvailable = (() => {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeBundle() {
  const root = await mkdtemp(join(tmpdir(), "github-native-git-test-"));
  temporaryDirectories.push(root);
  const source = join(root, "source");
  execFileSync("git", ["init", "-b", "main", source]);
  execFileSync("git", ["-C", source, "config", "user.name", "Fixture Author"]);
  execFileSync("git", ["-C", source, "config", "user.email", "fixture@example.com"]);
  await writeFile(join(source, "README.md"), "fixture\n");
  await writeFile(join(source, "binary.bin"), Buffer.from([0, 1, 2, 255]));
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "fixture base"]);
  const baseSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  await writeFile(join(source, "review.txt"), "prepared head\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "prepared head"]);
  const headSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", source, "branch", "review"]);
  execFileSync("git", ["-C", source, "update-ref", "refs/heads/main", baseSha]);
  await writeFile(join(source, "future.txt"), "hidden future head\n");
  execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "commit", "-m", "hidden future head"]);
  const futureSha = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", source, "branch", "future"]);
  execFileSync("git", ["-C", source, "update-ref", "refs/heads/main", baseSha]);
  const bundle = join(root, "fixture.bundle");
  execFileSync("git", ["-C", source, "bundle", "create", bundle, "--all"]);
  return { root, bundle: await readFile(bundle), baseSha, headSha, futureSha };
}

describe("native Git storage", () => {
  it("lets an active fixture import finish after smart HTTP shutdown", async () => {
    const fixture = await makeBundle();
    const store = createNativeGitStore();
    try {
      const imported = store.importBundle("example/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha },
      }, "main");
      await store.stopHttp();
      await expect(imported).resolves.toContain("example/project.git");
      expect(store.hasRepo("example/project")).toBe(true);
    } finally {
      await store.close();
    }
  });

  it("ignores inherited Git config overrides while creating and reading canonical repositories", async () => {
    const fixture = await makeBundle();
    const names = ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"] as const;
    const original = new Map(names.map((name) => [name, process.env[name]]));
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.bare";
    process.env.GIT_CONFIG_VALUE_0 = "false";
    const store = createNativeGitStore();
    try {
      await store.importBundle("example/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha },
      }, "main");
      expect(await store.run("example/project", ["config", "--get", "core.bare"])).toBe("true");
      expect(await store.run("example/project", ["rev-parse", "refs/heads/main"])).toBe(fixture.baseSha);
    } finally {
      for (const name of names) {
        const value = original.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await store.close();
    }
  });

  it("imports only pinned bundle refs and retains native objects and binary contents", async () => {
    const fixture = await makeBundle();
    const store = createNativeGitStore();
    try {
      const repo = await store.importBundle("example/project", fixture.bundle, {
        baseSha: fixture.baseSha,
        refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
      }, "main");

      expect(await store.run("example/project", ["rev-parse", "refs/heads/main"])).toBe(fixture.baseSha);
      expect(await store.run("example/project", ["rev-parse", "refs/heads/review"])).toBe(fixture.headSha);
      expect(await store.refs("example/project")).toEqual({ "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha });
      expect(await store.run("example/project", ["show-ref", "--verify", "refs/heads/future"]).then(() => true, () => false)).toBe(false);
      expect(await store.run("example/project", ["merge-base", "refs/heads/main", fixture.baseSha])).toBe(
        fixture.baseSha,
      );
      expect(await store.history("example/project", fixture.baseSha, fixture.headSha)).toMatchObject([
        { sha: fixture.headSha, message: "prepared head" },
      ]);
      expect(await store.changedFiles("example/project", fixture.baseSha, fixture.headSha)).toMatchObject([
        { path: "review.txt", status: "added", additions: 1 },
      ]);
      expect(await store.hasDiffAnchor("example/project", fixture.baseSha, fixture.headSha, "review.txt", 1, "RIGHT")).toBe(
        true,
      );
      expect(await store.hasDiffAnchor("example/project", fixture.baseSha, fixture.headSha, "review.txt", 1, "LEFT")).toBe(
        false,
      );
      expect(await store.run("example/project", ["show", "refs/heads/main:binary.bin"], { encoding: "buffer" })).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      expect(repo).toBe(store.gitDir("example/project"));
    } finally {
      await store.close();
    }
  });

  it("projects only native objects reachable from authorized refs into the REST store", async () => {
    const fixture = await makeBundle();
    const data = new Store();
    const native = createNativeGitStore().attach(data);
    seedFromConfig(data, "http://localhost:4000", {
      users: [{ login: "fixture-user", email: "fixture@example.com" }],
      repos: [{ owner: "fixture-user", name: "project", auto_init: false }],
    });
    await native.importBundle("fixture-user/project", fixture.bundle, {
      baseSha: fixture.baseSha,
      refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
    }, "main");
    await projectNativeGit("fixture-user/project", data);
    const gh = getGitHubStore(data);
    const repo = gh.repos.findOneBy("full_name", "fixture-user/project")!;
    try {
      expect(gh.refs.findBy("repo_id", repo.id).map((ref) => [ref.ref, ref.sha])).toEqual([
        ["refs/heads/main", fixture.baseSha],
        ["refs/heads/review", fixture.headSha],
      ]);
      expect(gh.branches.findBy("repo_id", repo.id).map((branch) => [branch.name, branch.sha])).toEqual([
        ["main", fixture.baseSha],
        ["review", fixture.headSha],
      ]);
      expect(gh.commits.findBy("repo_id", repo.id).map((commit) => commit.sha)).toContain(fixture.headSha);
      expect(gh.commits.findBy("repo_id", repo.id).map((commit) => commit.sha)).not.toContain(fixture.futureSha);
      expect(gh.blobs.findBy("repo_id", repo.id).map((blob) => blob.content)).toContain(
        Buffer.from([0, 1, 2, 255]).toString("base64"),
      );
    } finally {
      await native.close();
    }
  });

  it("rejects an imported fixture when any requested ref does not match its pinned SHA", async () => {
    const fixture = await makeBundle();
    const store = createNativeGitStore();
    try {
      await expect(
        store.importBundle("example/project", fixture.bundle, {
          baseSha: fixture.baseSha,
          refs: { "refs/heads/main": "0".repeat(40) },
        }, "main"),
      ).rejects.toThrow(/does not match pinned SHA/);
    } finally {
      await store.close();
    }
  });

  it("streams chunked binary requests and response output, and reaps the backend group on cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "github-http-stream-test-"));
    temporaryDirectories.push(root);
    const bin = join(root, "bin");
    const capture = join(root, "request.bin");
    const pidFile = join(root, "sleep.pid");
    await mkdir(bin);
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    await writeFile(join(bin, "git"), `#!/bin/sh
if [ "$1" = "http-backend" ]; then
  cat > '${capture}'
  sleep 30 &
  echo $! > '${pidFile}'
  printf 'Content-Type: application/octet-stream\\r\\n\\r\\nfirst'
  wait
  printf 'second'
  exit 0
fi
exec '${realGit}' "$@"
`, { mode: 0o755 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    const store = createNativeGitStore();
    const requestBytes = Buffer.from([0, 255, 1, 128, 10]);
    try {
      const result = await store.httpBackend(
        "example/project",
        "/example/project.git/git-upload-pack",
        "POST",
        "",
        "application/x-git-upload-pack-request",
        undefined,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(requestBytes.subarray(0, 2));
            controller.enqueue(requestBytes.subarray(2));
            controller.close();
          },
        }),
        undefined,
        "fixture-user",
      );
      expect(result.status).toBe(200);
      expect(await readFile(capture)).toEqual(requestBytes);
      const reader = result.body!.getReader();
      const first = await reader.read();
      expect(Buffer.from(first.value!)).toEqual(Buffer.from("first"));
      const childPid = Number((await readFile(pidFile, "utf8")).trim());
      await reader.cancel();
      await expectProcessExit(childPid);
    } finally {
      process.env.PATH = previousPath;
      await store.close();
    }
  });

  it.skipIf(!bunAvailable)("reaps native smart HTTP subprocesses when a Bun request stream fails", () => {
    const nativeGitUrl = new URL("../native-git.ts", import.meta.url).href;
    const script = `
const { createNativeGitStore } = await import(${JSON.stringify(nativeGitUrl)});
const native = createNativeGitStore();
let unhandledRejections = 0;
process.on("unhandledRejection", () => { unhandledRejections += 1; });
try {
  await native.httpBackend(
    "fixture/project",
    "/fixture/project.git/git-upload-pack",
    "POST",
    "",
    "application/x-git-upload-pack-request",
    undefined,
    new ReadableStream({ start(controller) { controller.error(new Error("synthetic input failure")); } }),
    undefined,
    "fixture",
  );
  throw new Error("httpBackend accepted the failed request stream");
} catch (error) {
  if (!(error instanceof Error) || error.message !== "synthetic input failure") throw error;
}
await native.close();
await new Promise((resolve) => setTimeout(resolve, 0));
if (unhandledRejections !== 0) throw new Error("request stream failure created an unhandled rejection");
console.log("BUN_HTTP_BACKEND_CLOSED");
`;
    const output = execFileSync("bun", ["run", "-"], { input: script, encoding: "utf8", timeout: 5000 });
    expect(output).toContain("BUN_HTTP_BACKEND_CLOSED");
  });

  it("serves native clone, exact SHA fetch, push, and binary contents over smart HTTP", async () => {
    const fixture = await makeBundle();
    const store = createNativeGitStore();
    await store.importBundle("example/project", fixture.bundle, {
      baseSha: fixture.baseSha,
      refs: { "refs/heads/main": fixture.baseSha, "refs/heads/review": fixture.headSha },
    }, "main");
    const server = createServer(async (request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const result = await store.httpBackend(
        "example/project",
        url.pathname,
        request.method ?? "GET",
        url.searchParams.toString(),
        String(request.headers["content-type"] ?? ""),
        typeof request.headers["git-protocol"] === "string" ? request.headers["git-protocol"] : undefined,
        Readable.toWeb(request),
        typeof request.headers["content-length"] === "string" ? request.headers["content-length"] : undefined,
        "fixture-user",
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      if (!result.body) {
        response.end();
        return;
      }
      for await (const chunk of Readable.fromWeb(result.body)) {
        if (!response.write(chunk)) await new Promise<void>((resolve) => response.once("drain", resolve));
      }
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    temporaryDirectories.push(fixture.root);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
    const url = `http://127.0.0.1:${address.port}/example/project.git`;
    const clone = join(fixture.root, "clone");
    try {
      const advertisement = await execFileAsync("git", ["ls-remote", "--heads", url], { timeout: 10000 });
      expect(advertisement.stdout).toContain(`refs/heads/main`);
      expect(advertisement.stdout).toContain(`refs/heads/review`);
      expect(advertisement.stdout).not.toContain("refs/heads/future");
      await execFileAsync("git", ["clone", url, clone], { timeout: 10000 });
      expect(execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(
        fixture.baseSha,
      );
      await execFileAsync("git", ["-C", clone, "fetch", "origin", fixture.headSha], { timeout: 10000 });
      expect(execFileSync("git", ["-C", clone, "show", `${fixture.baseSha}:binary.bin`])).toEqual(
        Buffer.from([0, 1, 2, 255]),
      );
      execFileSync("git", ["-C", clone, "checkout", "-b", "pushed", fixture.headSha]);
      await writeFile(join(clone, "pushed.bin"), Buffer.from([255, 0, 128]));
      execFileSync("git", ["-C", clone, "add", "."]);
      execFileSync("git", ["-C", clone, "config", "user.name", "Fixture Author"]);
      execFileSync("git", ["-C", clone, "config", "user.email", "fixture@example.com"]);
      execFileSync("git", ["-C", clone, "commit", "-m", "push binary"]);
      await execFileAsync("git", ["-C", clone, "push", "origin", "HEAD:refs/heads/pushed"], { timeout: 10000 });
      const pushedSha = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      expect(await store.run("example/project", ["rev-parse", "refs/heads/pushed"])).toBe(pushedSha);
      expect(await store.run("example/project", ["show", "refs/heads/pushed:pushed.bin"], { encoding: "buffer" })).toEqual(
        Buffer.from([255, 0, 128]),
      );
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await store.close();
    }
  });
});

async function expectProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} remained alive after backend cancellation`);
}
