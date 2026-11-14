import type { RouteContext } from "@emulators/core";
import { ApiError, parseJsonBody, parsePagination, setLinkHeader } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { lookupRepo, formatUser } from "../helpers.js";
import { assertAuthenticatedActor, assertRepoContentsWrite, assertRepoPermission, notFoundResponse, ownerLoginOf } from "../route-helpers.js";

const validStates = new Set(["error", "failure", "pending", "success"]);

export function commitStatusRoutes({ app, store, baseUrl, webhooks }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.get("/repos/:owner/:repo/commits/:ref{.+}/statuses", (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    assertRepoPermission(gh, authUser, repo, "statuses");
    if (authUser?.installation && !["read", "write"].includes(authUser.installation.permissions.statuses ?? "")) {
      throw new ApiError(403, "Resource not accessible by integration");
    }
    const ref = decodeURIComponent(c.req.param("ref")!);
    const known = gh.commits.findBy("repo_id", repo.id).some((commit) => commit.sha === ref) ||
      gh.refs.findBy("repo_id", repo.id).some((entry) => entry.ref === ref || entry.sha === ref) ||
      gh.branches.findBy("repo_id", repo.id).some((branch) => branch.name === ref || branch.sha === ref);
    if (!known) throw notFoundResponse();
    const statuses = gh.commitStatuses.findBy("repo_id", repo.id)
      .filter((status) => status.sha === ref || gh.refs.findBy("repo_id", repo.id).some((entry) => entry.ref === ref && entry.sha === status.sha) || gh.branches.findBy("repo_id", repo.id).some((branch) => branch.name === ref && branch.sha === status.sha))
      .sort((a, b) => b.id - a.id);
    const { page, per_page } = parsePagination(c);
    setLinkHeader(c, statuses.length, page, per_page);
    return c.json(statuses.slice((page - 1) * per_page, page * per_page).map((status) => {
      const creator = gh.users.get(status.creator_id);
      return {
        id: status.id,
        node_id: status.node_id,
        state: status.state,
        context: status.context,
        description: status.description,
        target_url: status.target_url,
        created_at: status.created_at,
        updated_at: status.updated_at,
        url: `${baseUrl}/repos/${repo.full_name}/statuses/${status.sha}`,
        avatar_url: creator ? formatUser(creator, baseUrl).avatar_url : "",
        creator: creator ? formatUser(creator, baseUrl) : null,
      };
    }));
  });

  app.post("/repos/:owner/:repo/statuses/:sha", async (c) => {
    const repo = lookupRepo(gh, c.req.param("owner")!, c.req.param("repo")!);
    if (!repo) throw notFoundResponse();
    const authUser = c.get("authUser");
    const actor = assertAuthenticatedActor(gh, authUser);
    if (authUser?.installation) {
      assertRepoPermission(gh, authUser, repo, "statuses", "write");
    } else {
      assertRepoContentsWrite(gh, authUser, repo);
    }
    const sha = c.req.param("sha")!;
    const hasCommit = gh.commits.findBy("repo_id", repo.id).some((commit) => commit.sha === sha);
    if (!hasCommit) throw notFoundResponse();
    const body = await parseJsonBody(c);
    if (typeof body.state !== "string" || !validStates.has(body.state)) throw new ApiError(422, "Validation failed");
    if (typeof body.context !== "string" || !body.context.trim()) throw new ApiError(422, "Validation failed");
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") throw new ApiError(422, "Validation failed");
    if (body.target_url !== undefined && body.target_url !== null && typeof body.target_url !== "string") throw new ApiError(422, "Validation failed");
    const row = gh.commitStatuses.insert({
      node_id: "",
      repo_id: repo.id,
      sha,
      state: body.state as "error" | "failure" | "pending" | "success",
      context: body.context,
      description: typeof body.description === "string" ? body.description : null,
      target_url: typeof body.target_url === "string" ? body.target_url : null,
      creator_id: actor.id,
    });
    const status = gh.commitStatuses.update(row.id, { node_id: `MDY6Q29tbWl0U3RhdHVz${row.id}` })!;
    await webhooks.dispatch("status", "created", {
      sha,
      state: status.state,
      context: status.context,
      description: status.description,
      target_url: status.target_url,
      creator: formatUser(actor, baseUrl),
      repository: { id: repo.id, name: repo.name, full_name: repo.full_name },
    }, ownerLoginOf(gh, repo), repo.name);
    return c.json({
      id: status.id,
      node_id: status.node_id,
      state: status.state,
      context: status.context,
      description: status.description,
      target_url: status.target_url,
      created_at: status.created_at,
      updated_at: status.updated_at,
      url: `${baseUrl}/repos/${repo.full_name}/statuses/${sha}`,
      creator: formatUser(actor, baseUrl),
    }, 201);
  });
}
