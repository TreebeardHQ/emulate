import type { Context } from "@emulators/core";
import type { RouteContext, WebhookDispatcher } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import type { GitHubStore } from "../store.js";
import type { GitHubComment, GitHubPullRequest, GitHubRepo, GitHubReview, GitHubUser } from "../entities.js";
import {
  formatComment,
  formatPullRequest,
  formatRepo,
  formatReview,
  formatUser,
  generateNodeId,
  generateSha,
  lookupRepo,
  timestamp,
} from "../helpers.js";
import { assertRepoPermission, assertRepoWrite, notFoundResponse, ownerLoginOf } from "../route-helpers.js";
import { getNativeGitStore } from "../native-git.js";

function findPull(gh: GitHubStore, repoId: number, pullNumber: number): GitHubPullRequest | undefined {
  return gh.pullRequests.findBy("repo_id", repoId).find((p) => p.number === pullNumber);
}

function findReview(gh: GitHubStore, repo: GitHubRepo, pullNumber: number, reviewId: number): GitHubReview | undefined {
  const r = gh.reviews.get(reviewId);
  if (!r || r.repo_id !== repo.id || r.pull_number !== pullNumber) return undefined;
  return r;
}

function adjustPrReviewCommentCount(gh: GitHubStore, pr: GitHubPullRequest, delta: number) {
  gh.pullRequests.update(pr.id, { review_comments: Math.max(0, pr.review_comments + delta) });
}

function sortComments(
  comments: GitHubComment[],
  sort: "created" | "updated",
  direction: "asc" | "desc",
): GitHubComment[] {
  const mul = direction === "asc" ? 1 : -1;
  const field = sort === "created" ? "created_at" : "updated_at";
  const sorted = [...comments];
  sorted.sort((a, b) => {
    const as = a[field];
    const bs = b[field];
    if (as < bs) return -1 * mul;
    if (as > bs) return 1 * mul;
    return a.id < b.id ? -1 * mul : a.id > b.id ? 1 * mul : 0;
  });
  return sorted;
}

function parseCommentSort(c: Context, defaultDirection: "asc" | "desc") {
  const sortRaw = c.req.query("sort") ?? "created";
  const sort: "created" | "updated" = sortRaw === "updated" ? "updated" : "created";
  const dirRaw = c.req.query("direction");
  const direction: "asc" | "desc" = dirRaw === "desc" ? "desc" : dirRaw === "asc" ? "asc" : defaultDirection;
  return { sort, direction };
}

function parseSubmitEvent(raw: unknown): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (raw === "APPROVE" || raw === "REQUEST_CHANGES" || raw === "COMMENT") return raw;
  throw new ApiError(422, "Validation failed");
}

function rejectSelfReview(event: ReturnType<typeof parseSubmitEvent>, actorId: number, authorId: number): void {
  if (actorId !== authorId || event === "COMMENT") return;
  const message = event === "APPROVE"
    ? "Review Can not approve your own pull request"
    : "Review Can not request changes on your own pull request";
  throw new ApiError(422, message);
}

function eventToState(event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"): GitHubReview["state"] {
  switch (event) {
    case "APPROVE":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    default:
      return "COMMENTED";
  }
}

async function dispatchReviewWebhook(
  webhooks: WebhookDispatcher,
  gh: GitHubStore,
  repo: GitHubRepo,
  review: GitHubReview,
  pr: GitHubPullRequest,
  actor: GitHubUser,
  baseUrl: string,
  action: "submitted" | "dismissed",
): Promise<void> {
  const ownerLogin = ownerLoginOf(gh, repo);
  const reviewFmt = formatReview(review, gh, baseUrl);
  if (!reviewFmt) return;
  await webhooks.dispatch(
    "pull_request_review",
    action,
    {
      action,
      review: reviewFmt,
      pull_request: formatPullRequest(pr, gh, baseUrl),
      repository: formatRepo(repo, gh, baseUrl),
      sender: formatUser(actor, baseUrl),
    },
    ownerLogin,
    repo.name,
  );
}

export function reviewsRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/pulls/:pull_number/reviews", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const list = gh.reviews.findBy("repo_id", repo.id).filter((r) => r.pull_number === pullNumber);
    list.sort((a, b) => a.id - b.id);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((r) => formatReview(r, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });

  app.post("/repos/:owner/:repo/pulls/:pull_number/reviews", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    if (!Number.isFinite(pullNumber)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const raw = await parseJsonBody(c);

    const eventRaw = raw.event;
    const hasEvent = eventRaw === "APPROVE" || eventRaw === "REQUEST_CHANGES" || eventRaw === "COMMENT";
    if (eventRaw !== undefined && eventRaw !== null && !hasEvent) {
      throw new ApiError(422, "Validation failed");
    }
    const event = hasEvent ? parseSubmitEvent(eventRaw) : undefined;
    if (event) rejectSelfReview(event, actor.id, pr.user_id);

    let bodyText: string | null = null;
    if (typeof raw.body === "string") bodyText = raw.body;
    else if (raw.body === null || raw.body === undefined) bodyText = null;
    else throw new ApiError(422, "Validation failed");

    const nativeGit = store.getData<boolean>("github.native_git") === true ? getNativeGitStore(store) : undefined;
    if (nativeGit && !nativeGit.hasRepo(repo.full_name)) {
      throw new ApiError(503, "Native Git repository is not initialized");
    }
    if (nativeGit && raw.commit_id !== undefined && raw.commit_id !== null && typeof raw.commit_id !== "string") {
      throw new ApiError(422, "Validation failed");
    }
    const commitId =
      typeof raw.commit_id === "string" && raw.commit_id.trim() ? raw.commit_id.trim() : pr.head_sha || generateSha();
    if (nativeGit) {
      if (!/^[0-9a-f]{40,64}$/i.test(commitId) || !/^[0-9a-f]{40,64}$/i.test(pr.base_sha)) {
        throw new ApiError(422, "Validation failed");
      }
      try {
        if ((await nativeGit.resolve(repo.full_name, commitId)).type !== "commit") throw new ApiError(422, "Validation failed");
        if ((await nativeGit.resolve(repo.full_name, pr.base_sha)).type !== "commit") throw new ApiError(422, "Validation failed");
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(422, "Validation failed");
      }
    }

    const rawComments = raw.comments;
    if (rawComments !== undefined && !Array.isArray(rawComments)) throw new ApiError(422, "Validation failed");
    const comments = (rawComments ?? []) as unknown[];
    const commentDrafts: Array<{
      body: string;
      path: string;
      position: number | null;
      line: number | null;
      side: "LEFT" | "RIGHT" | null;
    }> = [];
    for (const entry of comments) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ApiError(422, "Validation failed");
      const o = entry as Record<string, unknown>;
      if (typeof o.path !== "string" || !o.path.trim() || typeof o.body !== "string") {
        throw new ApiError(422, "Validation failed");
      }
      if (nativeGit) {
        const line = o.line;
        const side = o.side === undefined ? "RIGHT" : o.side;
        if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || (side !== "LEFT" && side !== "RIGHT")) {
          throw new ApiError(422, "Validation failed");
        }
        if (!(await nativeGit.hasDiffAnchor(repo.full_name, pr.base_sha, commitId, o.path, line, side))) {
          throw new ApiError(422, "Validation failed");
        }
        commentDrafts.push({ body: o.body, path: o.path, position: null, line, side });
      } else {
        const position = typeof o.position === "number" && Number.isFinite(o.position) ? o.position : parseInt(String(o.position), 10);
        if (!Number.isFinite(position)) throw new ApiError(422, "Validation failed");
        commentDrafts.push({ body: o.body, path: o.path, position, line: null, side: "RIGHT" });
      }
    }

    const state: GitHubReview["state"] = event ? eventToState(event) : "PENDING";
    const submittedAt = event ? timestamp() : null;

    const row = gh.reviews.insert({
      node_id: "",
      repo_id: repo.id,
      pull_number: pullNumber,
      user_id: actor.id,
      body: bodyText,
      state,
      commit_id: commitId,
      submitted_at: submittedAt,
    } as Omit<GitHubReview, "id" | "created_at" | "updated_at">);
    gh.reviews.update(row.id, { node_id: generateNodeId("PullRequestReview", row.id) });
    const review = gh.reviews.get(row.id)!;

    for (const draft of commentDrafts) {
      const cRow = gh.comments.insert({
        node_id: "",
        repo_id: repo.id,
        issue_number: null,
        pull_number: pullNumber,
        commit_sha: commitId,
        body: draft.body,
        user_id: actor.id,
        in_reply_to_id: null,
        path: draft.path,
        position: draft.position,
        line: draft.line,
        side: draft.side,
        subject_type: "line",
        comment_type: "review",
        review_id: review.id,
      } as Omit<GitHubComment, "id" | "created_at" | "updated_at">);
      gh.comments.update(cRow.id, { node_id: generateNodeId("PullRequestReviewComment", cRow.id) });
      adjustPrReviewCommentCount(gh, pr, 1);
    }

    if (event) {
      await dispatchReviewWebhook(webhooks, gh, repo, review, pr, actor, baseUrl, "submitted");
    }

    const json = formatReview(review, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    const reviewId = parseInt(c.req.param("review_id")!, 10);
    if (!Number.isFinite(pullNumber) || !Number.isFinite(reviewId)) throw notFoundResponse();

    const review = findReview(gh, repo, pullNumber, reviewId);
    if (!review) throw notFoundResponse();

    const json = formatReview(review, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.put("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    const reviewId = parseInt(c.req.param("review_id")!, 10);
    if (!Number.isFinite(pullNumber) || !Number.isFinite(reviewId)) throw notFoundResponse();

    const existing = findReview(gh, repo, pullNumber, reviewId);
    if (!existing) throw notFoundResponse();

    const raw = await parseJsonBody(c);
    if (typeof raw.body !== "string" && raw.body !== null) {
      throw new ApiError(422, "Validation failed");
    }
    const bodyVal = typeof raw.body === "string" ? raw.body : null;

    const updated = gh.reviews.update(reviewId, { body: bodyVal });
    if (!updated) throw notFoundResponse();

    const json = formatReview(updated, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.post("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id/events", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    const reviewId = parseInt(c.req.param("review_id")!, 10);
    if (!Number.isFinite(pullNumber) || !Number.isFinite(reviewId)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const review = findReview(gh, repo, pullNumber, reviewId);
    if (!review) throw notFoundResponse();
    if (review.state !== "PENDING") {
      throw new ApiError(422, "Validation failed");
    }

    const raw = await parseJsonBody(c);
    const event = parseSubmitEvent(raw.event);
    rejectSelfReview(event, actor.id, pr.user_id);

    let bodyText: string | null = review.body;
    if (typeof raw.body === "string") bodyText = raw.body;
    else if (raw.body === null) bodyText = null;
    else if (raw.body !== undefined) throw new ApiError(422, "Validation failed");

    const nextState = eventToState(event);
    const updated = gh.reviews.update(reviewId, {
      body: bodyText,
      state: nextState,
      submitted_at: timestamp(),
    });
    if (!updated) throw notFoundResponse();

    await dispatchReviewWebhook(webhooks, gh, repo, updated, pr, actor, baseUrl, "submitted");

    const json = formatReview(updated, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.put("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id/dismissals", async (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();

    const actor = assertRepoWrite(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    const reviewId = parseInt(c.req.param("review_id")!, 10);
    if (!Number.isFinite(pullNumber) || !Number.isFinite(reviewId)) throw notFoundResponse();

    const pr = findPull(gh, repo.id, pullNumber);
    if (!pr) throw notFoundResponse();

    const review = findReview(gh, repo, pullNumber, reviewId);
    if (!review) throw notFoundResponse();
    if (review.state === "PENDING" || review.state === "DISMISSED") {
      throw new ApiError(422, "Validation failed");
    }

    const raw = await parseJsonBody(c);
    const message = typeof raw.message === "string" ? raw.message : null;

    const updated = gh.reviews.update(reviewId, {
      state: "DISMISSED",
      body: message !== null && message !== undefined ? message : review.body,
    });
    if (!updated) throw notFoundResponse();

    await dispatchReviewWebhook(webhooks, gh, repo, updated, pr, actor, baseUrl, "dismissed");

    const json = formatReview(updated, gh, baseUrl);
    if (!json) throw notFoundResponse();
    return c.json(json);
  });

  app.get("/repos/:owner/:repo/pulls/:pull_number/reviews/:review_id/comments", (c) => {
    const owner = c.req.param("owner")!;
    const repoName = c.req.param("repo")!;
    const repo = lookupRepo(gh, owner, repoName);
    if (!repo) throw notFoundResponse();
    assertRepoPermission(gh, c.get("authUser"), repo, "pull_requests");

    const pullNumber = parseInt(c.req.param("pull_number")!, 10);
    const reviewId = parseInt(c.req.param("review_id")!, 10);
    if (!Number.isFinite(pullNumber) || !Number.isFinite(reviewId)) throw notFoundResponse();

    const review = findReview(gh, repo, pullNumber, reviewId);
    if (!review) throw notFoundResponse();

    const { page, per_page } = parsePagination(c);
    const { sort, direction } = parseCommentSort(c, "asc");

    let list = gh.comments
      .findBy("repo_id", repo.id)
      .filter((x) => x.comment_type === "review" && x.pull_number === pullNumber && x.review_id === reviewId);
    list = sortComments(list, sort, direction);
    const total = list.length;
    setLinkHeader(c, total, page, per_page);
    const start = (page - 1) * per_page;
    const pageItems = list.slice(start, start + per_page);
    const body = pageItems
      .map((x) => formatComment(x, gh, baseUrl))
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return c.json(body);
  });
}
