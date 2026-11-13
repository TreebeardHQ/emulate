import type { Store } from "@emulators/core";
import { getGitHubStore } from "./store.js";
import type { GitHubBlob, GitHubCommit, GitHubTree } from "./entities.js";
import { generateNodeId } from "./helpers.js";
import { getNativeGitStore } from "./native-git.js";

function commitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Native Git commit has an invalid timestamp");
  return date.toISOString();
}

export async function projectNativeGit(fullName: string, store: Store): Promise<void> {
  const gh = getGitHubStore(store);
  const repo = gh.repos.findOneBy("full_name", fullName);
  if (!repo) throw new Error(`Repository ${fullName} is not seeded in the GitHub store`);
  const git = getNativeGitStore(store);
  const refs = await git.refs(fullName);

  for (const ref of gh.refs.findBy("repo_id", repo.id)) gh.refs.delete(ref.id);
  for (const [ref, sha] of Object.entries(refs)) {
    const inserted = gh.refs.insert({ repo_id: repo.id, ref, sha, node_id: "" });
    gh.refs.update(inserted.id, { node_id: generateNodeId("Ref", inserted.id) });
  }

  const heads = new Map(
    Object.entries(refs)
      .filter(([ref]) => ref.startsWith("refs/heads/"))
      .map(([ref, sha]) => [ref.slice("refs/heads/".length), sha]),
  );
  for (const branch of gh.branches.findBy("repo_id", repo.id)) {
    const sha = heads.get(branch.name);
    if (sha) {
      gh.branches.update(branch.id, { sha });
      heads.delete(branch.name);
    } else {
      gh.branches.delete(branch.id);
    }
  }
  for (const [name, sha] of heads) {
    gh.branches.insert({ repo_id: repo.id, name, sha, protected: false });
  }

  const commitShas = ((await git.run(fullName, ["rev-list", "--all"])) as string).split("\n").filter(Boolean);
  const retainedCommitShas = new Set(commitShas);
  const retainedTreeShas = new Set<string>();
  const retainedBlobShas = new Set<string>();
  const existingCommits = new Map(gh.commits.findBy("repo_id", repo.id).map((commit) => [commit.sha, commit]));
  const usersByEmail = new Map(gh.users.all().filter((user) => user.email).map((user) => [user.email!, user.id]));
  for (const sha of commitShas) {
    const object = await git.commitObject(fullName, sha);
    retainedTreeShas.add(object.treeSha);
    const existing = existingCommits.get(object.sha);
    const commit: Omit<GitHubCommit, "id" | "created_at" | "updated_at"> = {
      repo_id: repo.id,
      sha: object.sha,
      node_id: existing?.node_id ?? "",
      message: object.message,
      author_name: object.authorName,
      author_email: object.authorEmail,
      author_date: commitDate(object.authorDate),
      committer_name: object.committerName,
      committer_email: object.committerEmail,
      committer_date: commitDate(object.committerDate),
      tree_sha: object.treeSha,
      parent_shas: object.parentShas,
      user_id: usersByEmail.get(object.authorEmail) ?? null,
    };
    if (existing) gh.commits.update(existing.id, commit);
    else {
      const inserted = gh.commits.insert(commit);
      gh.commits.update(inserted.id, { node_id: generateNodeId("Commit", inserted.id) });
    }
  }
  for (const commit of gh.commits.findBy("repo_id", repo.id)) {
    if (!retainedCommitShas.has(commit.sha)) gh.commits.delete(commit.id);
  }

  const treeEntries = new Map<string, GitHubTree["tree"]>();
  const existingTrees = new Map(gh.trees.findBy("repo_id", repo.id).map((tree) => [tree.sha, tree]));
  const pendingTrees = [...retainedTreeShas];
  while (pendingTrees.length) {
    const sha = pendingTrees.pop()!;
    if (treeEntries.has(sha)) continue;
    const entries = await git.tree(fullName, sha);
    const formatted = entries.map((entry) => ({ ...entry }));
    treeEntries.set(sha, formatted);
    for (const entry of entries) {
      if (entry.type === "tree") pendingTrees.push(entry.sha);
      if (entry.type === "blob") retainedBlobShas.add(entry.sha);
    }
  }
  for (const [sha, entries] of treeEntries) {
    const existing = existingTrees.get(sha);
    const tree: Omit<GitHubTree, "id" | "created_at" | "updated_at"> = {
      repo_id: repo.id,
      sha,
      node_id: existing?.node_id ?? "",
      tree: entries,
      truncated: false,
    };
    if (existing) gh.trees.update(existing.id, tree);
    else {
      const inserted = gh.trees.insert(tree);
      gh.trees.update(inserted.id, { node_id: generateNodeId("Tree", inserted.id) });
    }
  }
  for (const tree of gh.trees.findBy("repo_id", repo.id)) {
    if (!treeEntries.has(tree.sha)) gh.trees.delete(tree.id);
  }

  const existingBlobs = new Map(gh.blobs.findBy("repo_id", repo.id).map((blob) => [blob.sha, blob]));
  for (const sha of retainedBlobShas) {
    const bytes = await git.blob(fullName, sha);
    const existing = existingBlobs.get(sha);
    const blob: Omit<GitHubBlob, "id" | "created_at" | "updated_at"> = {
      repo_id: repo.id,
      sha,
      node_id: existing?.node_id ?? "",
      content: bytes.toString("base64"),
      encoding: "base64",
      size: bytes.byteLength,
    };
    if (existing) gh.blobs.update(existing.id, blob);
    else {
      const inserted = gh.blobs.insert(blob);
      gh.blobs.update(inserted.id, { node_id: generateNodeId("Blob", inserted.id) });
    }
  }
  for (const blob of gh.blobs.findBy("repo_id", repo.id)) {
    if (!retainedBlobShas.has(blob.sha)) gh.blobs.delete(blob.id);
  }
}
