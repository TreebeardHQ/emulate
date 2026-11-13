import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import type { Store } from "@emulators/core";

const execFileAsync = promisify(execFile);
const stores = new WeakMap<Store, NativeGitStore>();

export interface NativeGitPins {
  baseSha: string;
  refs: Record<string, string>;
}

export interface NativeGitCommit {
  sha: string;
  treeSha: string;
  parentShas: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
}

export interface NativeGitChangedFile {
  path: string;
  previousPath?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

export interface NativeGitTreeEntry {
  path: string;
  mode: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
}

export class NativeGitStore {
  private root?: string;
  private closed = false;
  private readonly initializedRepos = new Set<string>();

  attach(store: Store): this {
    stores.set(store, this);
    store.setData("github.native_git", true);
    return this;
  }

  async importBundle(fullName: string, bundle: Uint8Array, pins: NativeGitPins, defaultBranch: string): Promise<string> {
    const gitDir = await this.ensureRepoDir(fullName);
    this.initializedRepos.delete(fullName);
    await rm(gitDir, { recursive: true, force: true });
    await mkdir(dirname(gitDir), { recursive: true });
    await this.git(gitDir, ["init", "--bare"]);
    await this.configure(gitDir);
    const bundlePath = join(await this.ensureRoot(), `.bundle-${randomUUID()}`);
    try {
      await writeFile(bundlePath, bundle, { mode: 0o600 });
      await this.git(gitDir, ["bundle", "verify", bundlePath]);
      await this.git(gitDir, ["bundle", "unbundle", bundlePath]);
      if (!/^[0-9a-f]{40,64}$/i.test(pins.baseSha)) throw new Error("Base SHA is invalid");
      await this.git(gitDir, ["cat-file", "-e", `${pins.baseSha}^{commit}`]);
      await this.git(gitDir, ["check-ref-format", `refs/heads/${defaultBranch}`]);
      if (!Object.keys(pins.refs).some((ref) => ref.startsWith("refs/heads/"))) {
        throw new Error("Fixture must pin at least one branch ref");
      }
      for (const [ref, sha] of Object.entries(pins.refs)) {
        if (!/^refs\/(heads|tags)\//.test(ref)) {
          throw new Error(`Fixture ref is invalid: ${ref}`);
        }
        await this.git(gitDir, ["check-ref-format", ref]);
        if (!/^[0-9a-f]{40,64}$/i.test(sha)) throw new Error(`Fixture SHA is invalid for ${ref}`);
        try {
          await this.git(gitDir, ["cat-file", "-e", `${sha}^{object}`]);
        } catch {
          throw new Error(`Fixture ref ${ref} does not match pinned SHA`);
        }
        await this.git(gitDir, ["update-ref", ref, sha]);
        const actual = await this.git(gitDir, ["rev-parse", ref]);
        if (actual !== sha) throw new Error(`Fixture ref ${ref} does not match pinned SHA`);
      }
      if (!pins.refs[`refs/heads/${defaultBranch}`]) {
        throw new Error("Fixture default branch must be one of the pinned refs");
      }
      await this.git(gitDir, ["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
      await this.git(gitDir, ["update-server-info"]);
      this.initializedRepos.add(fullName);
      return gitDir;
    } catch (error) {
      await rm(gitDir, { recursive: true, force: true });
      throw error;
    } finally {
      await rm(bundlePath, { force: true });
    }
  }

  gitDir(fullName: string): string {
    this.assertOpen();
    const [owner, repo] = this.parseName(fullName);
    return join(this.root ?? "", owner, `${repo}.git`);
  }

  hasRepo(fullName: string): boolean {
    if (this.closed || !this.initializedRepos.has(fullName)) return false;
    return existsSync(this.gitDir(fullName));
  }

  async run(
    fullName: string,
    args: string[],
    options: { encoding?: "utf8" | "buffer" } = {},
  ): Promise<string | Buffer> {
    const gitDir = this.gitDir(fullName);
    return this.git(gitDir, args, options);
  }

  async refs(fullName: string): Promise<Record<string, string>> {
    const output = await this.run(fullName, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    return Object.fromEntries(
      (output as string)
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf(" ");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  }

  async hasBranch(fullName: string, branchName: string): Promise<boolean> {
    return Object.hasOwn(await this.refs(fullName), `refs/heads/${branchName}`);
  }

  async canMerge(fullName: string, baseSha: string, headSha: string): Promise<boolean> {
    const gitDir = this.gitDir(fullName);
    return new Promise<boolean>((resolveMerge, reject) => {
      const child = spawn("git", ["--git-dir", gitDir, "merge-tree", "--write-tree", baseSha, headSha], {
        env: {
          PATH: process.env.PATH,
          HOME: gitDir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolveMerge(true);
        else if (code === 1) resolveMerge(false);
        else reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git merge-tree exited ${code}`));
      });
    });
  }

  async resolve(fullName: string, ref: string): Promise<{ sha: string; type: string }> {
    const sha = (await this.run(fullName, ["rev-parse", "--verify", `${ref}^{object}`])) as string;
    const type = (await this.run(fullName, ["cat-file", "-t", sha])) as string;
    return { sha, type };
  }

  async history(fullName: string, baseSha: string, headSha: string): Promise<NativeGitCommit[]> {
    const output = (await this.run(fullName, ["rev-list", "--reverse", `${baseSha}..${headSha}`])) as string;
    const commits: NativeGitCommit[] = [];
    for (const sha of output.split("\n").filter(Boolean)) commits.push(await this.commitObject(fullName, sha));
    return commits;
  }

  async commitObject(fullName: string, sha: string): Promise<NativeGitCommit> {
    const format = ["%H", "%T", "%P", "%an", "%ae", "%aI", "%cn", "%ce", "%cI", "%B"].join("%x00");
    const output = (await this.run(fullName, ["show", "-s", `--format=${format}`, sha])) as string;
    const [commitSha, treeSha, parents, authorName, authorEmail, authorDate, committerName, committerEmail, committerDate, message] = output.split("\0");
    if (!commitSha || !treeSha) throw new Error(`Git commit ${sha} could not be read`);
    return {
      sha: commitSha.trim(),
      treeSha: treeSha.trim(),
      parentShas: (parents ?? "").trim().split(/\s+/).filter(Boolean),
      authorName: authorName ?? "",
      authorEmail: authorEmail ?? "",
      authorDate: authorDate ?? "",
      committerName: committerName ?? "",
      committerEmail: committerEmail ?? "",
      committerDate: committerDate ?? "",
      message: (message ?? "").replace(/^\n+|\n+$/g, ""),
    };
  }

  async changedFiles(fullName: string, baseSha: string, headSha: string): Promise<NativeGitChangedFile[]> {
    const output = (await this.run(fullName, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--name-status", "-z", `${baseSha}...${headSha}`], {
      encoding: "buffer",
    })) as Buffer;
    const fields = output.toString("utf8").split("\0").filter(Boolean);
    const files: NativeGitChangedFile[] = [];
    for (let index = 0; index < fields.length; ) {
      const status = fields[index++]!;
      const rename = status.startsWith("R") || status.startsWith("C");
      const firstPath = fields[index++]!;
      const secondPath = rename ? fields[index++] : undefined;
      const path = secondPath ?? firstPath;
      const statOutput = (await this.run(fullName, ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--numstat", `${baseSha}...${headSha}`, "--", path], {
        encoding: "buffer",
      })) as Buffer;
      const stat = statOutput.toString("utf8").split("\t");
      const patchOutput = (await this.run(fullName, ["diff", "--no-ext-diff", "--no-color", "--unified=3", "--find-renames", `${baseSha}...${headSha}`, "--", path], {
        encoding: "buffer",
      })) as Buffer;
      const patch = patchOutput.toString("utf8");
      files.push({
        path,
        previousPath: rename ? firstPath : undefined,
        status: status[0] === "R" ? "renamed" : status[0] === "A" ? "added" : status[0] === "D" ? "removed" : "modified",
        additions: stat[0] === "-" ? 0 : Number(stat[0] ?? 0),
        deletions: stat[1] === "-" ? 0 : Number(stat[1] ?? 0),
        patch: patch || undefined,
      });
    }
    return files;
  }

  async tree(fullName: string, sha: string, recursive = false): Promise<NativeGitTreeEntry[]> {
    const output = (await this.run(fullName, ["ls-tree", ...(recursive ? ["-r"] : []), "-z", "--full-tree", sha], { encoding: "buffer" })) as Buffer;
    const entries: NativeGitTreeEntry[] = [];
    for (const raw of output.toString("utf8").split("\0").filter(Boolean)) {
      const [metadata, path] = raw.split("\t", 2);
      const [mode, type, objectSha] = (metadata ?? "").split(" ");
      if (!mode || !type || !objectSha || !path) continue;
      const size = type === "blob" ? Number(await this.run(fullName, ["cat-file", "-s", objectSha])) : undefined;
      entries.push({ path, mode, type: type as NativeGitTreeEntry["type"], sha: objectSha, ...(size === undefined ? {} : { size }) });
    }
    return entries;
  }

  async blob(fullName: string, sha: string): Promise<Buffer> {
    return (await this.run(fullName, ["cat-file", "blob", sha], { encoding: "buffer" })) as Buffer;
  }

  async diff(fullName: string, baseSha: string, headSha: string): Promise<Buffer> {
    return (await this.run(fullName, ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-color", "--binary", "--find-renames", `${baseSha}...${headSha}`], {
      encoding: "buffer",
    })) as Buffer;
  }

  async httpBackend(
    fullName: string,
    pathInfo: string,
    method: string,
    query: string,
    contentType: string,
    protocol: string | undefined,
    body: Uint8Array,
    remoteUser: string,
  ): Promise<Response> {
    const [owner, repo] = this.parseName(fullName);
    const root = await this.ensureRoot();
    const expectedPrefix = `/${owner}/${repo}.git/`;
    if (!pathInfo.startsWith(expectedPrefix) || pathInfo.includes("..") || pathInfo.includes("\\")) {
      return new Response("Not Found", { status: 404 });
    }
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: root,
      PATH_INFO: pathInfo,
      REQUEST_METHOD: method,
      QUERY_STRING: query,
      CONTENT_TYPE: contentType,
      CONTENT_LENGTH: String(body.byteLength),
      REMOTE_USER: remoteUser,
    };
    if (protocol) env.HTTP_GIT_PROTOCOL = protocol;
    const output = await new Promise<Buffer>((resolveOutput, reject) => {
      const child = spawn("git", ["http-backend"], { env, stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `git http-backend exited ${code}`));
          return;
        }
        resolveOutput(Buffer.concat(stdout));
      });
      child.stdin.end(body);
    });
    const separator = output.indexOf(Buffer.from("\r\n\r\n"));
    const separatorLength = 4;
    const fallbackSeparator = separator === -1 ? output.indexOf(Buffer.from("\n\n")) : separator;
    const actualSeparatorLength = separator === -1 ? 2 : separatorLength;
    if (fallbackSeparator === -1) return new Response(output, { status: 502 });
    const headerText = output.subarray(0, fallbackSeparator).toString("latin1");
    const responseBody = output.subarray(fallbackSeparator + actualSeparatorLength);
    const headers = new Headers();
    let status = 200;
    for (const line of headerText.split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (name.toLowerCase() === "status") status = Number(value.slice(0, 3)) || 200;
      else headers.append(name, value);
    }
    return new Response(responseBody, { status, headers });
  }

  async hasDiffAnchor(
    fullName: string,
    baseSha: string,
    headSha: string,
    path: string,
    line: number,
    side: "LEFT" | "RIGHT",
  ): Promise<boolean> {
    if (!Number.isSafeInteger(line) || line < 1) return false;
    const diff = (await this.diff(fullName, baseSha, headSha)).toString("utf8");
    let currentPath: string | undefined;
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    for (const row of diff.split("\n")) {
      if (row.startsWith("diff --git ")) {
        currentPath = undefined;
        inHunk = false;
        continue;
      }
      if (row.startsWith("--- a/")) {
        currentPath = row.slice(6);
        continue;
      }
      if (row.startsWith("+++ b/")) {
        currentPath = row.slice(6);
        continue;
      }
      if (row === "+++ /dev/null") continue;
      const hunk = row.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (!inHunk || !currentPath || (!row.startsWith(" ") && !row.startsWith("+") && !row.startsWith("-"))) continue;
      if (row.startsWith("\\")) continue;
      if (row.startsWith(" ")) {
        if (currentPath === path && ((side === "LEFT" && oldLine === line) || (side === "RIGHT" && newLine === line))) {
          return true;
        }
        oldLine += 1;
        newLine += 1;
      } else if (row.startsWith("-")) {
        if (currentPath === path && side === "LEFT" && oldLine === line) return true;
        oldLine += 1;
      } else if (row.startsWith("+")) {
        if (currentPath === path && side === "RIGHT" && newLine === line) return true;
        newLine += 1;
      }
    }
    return false;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.root) await rm(this.root, { recursive: true, force: true });
  }

  private async ensureRepoDir(fullName: string): Promise<string> {
    this.assertOpen();
    const [owner, repo] = this.parseName(fullName);
    const root = await this.ensureRoot();
    const gitDir = join(root, owner, `${repo}.git`);
    await mkdir(dirname(gitDir), { recursive: true });
    return gitDir;
  }

  private async ensureRoot(): Promise<string> {
    this.assertOpen();
    if (!this.root) this.root = await mkdtemp(join(tmpdir(), "emulate-github-git-"));
    await mkdir(this.root, { recursive: true });
    return this.root;
  }

  private parseName(fullName: string): [string, string] {
    this.assertOpen();
    const parts = fullName.split("/");
    if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === "." || part === "..")) {
      throw new Error("Repository name is invalid");
    }
    return [parts[0]!, parts[1]!];
  }

  private async configure(gitDir: string): Promise<void> {
    await this.git(gitDir, ["config", "uploadpack.allowAnySHAInWant", "true"]);
    await this.git(gitDir, ["config", "http.receivepack", "true"]);
    await this.git(gitDir, ["config", "core.hooksPath", "/dev/null"]);
  }

  private async git(
    gitDir: string,
    args: string[],
    options: { encoding?: "utf8" | "buffer" } = {},
  ): Promise<string | Buffer> {
    this.assertOpen();
    try {
      const result = await execFileAsync("git", ["--git-dir", gitDir, ...args], {
        env: {
          PATH: process.env.PATH,
          HOME: gitDir,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        encoding: options.encoding === "buffer" ? "buffer" : "utf8",
        maxBuffer: 128 * 1024 * 1024,
      });
      return options.encoding === "buffer" ? (result.stdout as Buffer) : String(result.stdout).trimEnd();
    } catch (error) {
      if (error && typeof error === "object" && "stderr" in error) {
        throw new Error(String(error.stderr).trim() || `git ${args[0]} failed`, { cause: error });
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Native Git store is closed");
  }
}

export function createNativeGitStore(): NativeGitStore {
  return new NativeGitStore();
}

export function getNativeGitStore(store: Store): NativeGitStore {
  const nativeGit = stores.get(store);
  if (!nativeGit) throw new Error("Native Git is not initialized for this GitHub store");
  return nativeGit;
}

