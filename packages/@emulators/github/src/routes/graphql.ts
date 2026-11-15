import type { RouteContext } from "@emulators/core";
import { parseJsonBody } from "@emulators/core";
import { getGitHubStore } from "../store.js";
import { lookupRepo } from "../helpers.js";
import { assertRepoPermission, assertAuthenticatedActor } from "../route-helpers.js";

type MergeGateVariables = { owner?: unknown; repo?: unknown; number?: unknown };

const PROTECTION_READ_POLICY_KEY = "github.fixture.protectionReadDeniedRepos";

export function setProtectionReadDenied(store: RouteContext["store"], repoFullName: string, denied: boolean): boolean {
  const deniedRepos = store.getData<Set<string>>(PROTECTION_READ_POLICY_KEY) ?? new Set<string>();
  const wasDenied = deniedRepos.has(repoFullName);
  if (denied === wasDenied) return false;
  if (denied) deniedRepos.add(repoFullName);
  else deniedRepos.delete(repoFullName);
  store.setData(PROTECTION_READ_POLICY_KEY, deniedRepos);
  return true;
}

function protectionReadDenied(store: RouteContext["store"], repoFullName: string): boolean {
  return store.getData<Set<string>>(PROTECTION_READ_POLICY_KEY)?.has(repoFullName) ?? false;
}

/** Implements the one concrete GraphQL projection used by the PR review merge gate. */
export function githubGraphqlRoutes({ app, store }: RouteContext): void {
  const gh = getGitHubStore(store);

  app.post("/graphql", async (c) => {
    const request = await parseJsonBody(c);
    const query = typeof request.query === "string" ? request.query : "";
    if (!query.includes("query MergeGate") || !query.includes("branchProtectionRule")) {
      return c.json({ errors: [{ message: "Unsupported query" }] }, 400);
    }
    const variables = (request.variables ?? {}) as MergeGateVariables;
    if (
      typeof variables.owner !== "string" ||
      typeof variables.repo !== "string" ||
      !Number.isInteger(variables.number)
    ) {
      return c.json({ errors: [{ message: "Invalid query variables" }] }, 400);
    }

    const repository = lookupRepo(gh, variables.owner, variables.repo);
    if (!repository) return c.json({ data: { repository: null } });
    const authUser = c.get("authUser");
    // Merge-gate data is an authenticated API projection, including for public repositories.
    assertAuthenticatedActor(gh, authUser);
    try {
      assertRepoPermission(gh, authUser, repository, "pull_requests");
    } catch {
      return c.json({ data: { repository: null } });
    }
    if (
      authUser?.installation &&
      authUser.installation.permissions.pull_requests !== "read" &&
      authUser.installation.permissions.pull_requests !== "write"
    ) {
      return c.json({
        data: null,
        errors: [{ type: "FORBIDDEN", extensions: { code: "FORBIDDEN" }, message: "Resource not accessible by integration" }],
      });
    }
    if (
      authUser?.installation &&
      authUser.installation.permissions.administration !== "read" &&
      authUser.installation.permissions.administration !== "write"
    ) {
      return c.json({
        data: null,
        errors: [{ type: "FORBIDDEN", extensions: { code: "FORBIDDEN" }, message: "Resource not accessible by integration" }],
      });
    }

    if (protectionReadDenied(store, repository.full_name)) {
      return c.json({ message: "Resource not accessible by integration" }, 403);
    }

    const pr = gh.pullRequests
      .findBy("repo_id", repository.id)
      .find((candidate) => candidate.number === variables.number);
    if (!pr) return c.json({ data: { repository: { pullRequest: null } } });

    const protection = gh.branchProtections
      .findBy("repo_id", pr.base_repo_id)
      .find((candidate) => candidate.branch_name === pr.base_ref);
    const checkRows = protection?.required_status_checks
      ? (protection.required_status_checks.checks ?? protection.required_status_checks.contexts.map((context) => ({ context, app_id: null })))
      : null;
    const author = gh.users.get(pr.user_id);
    const headRepository = gh.repos.get(pr.head_repo_id);
    return c.json({
      data: {
        repository: {
          pullRequest: {
            state: pr.merged ? "MERGED" : pr.state.toUpperCase(),
            isDraft: pr.draft,
            headRefOid: pr.head_sha,
            author: author ? { login: author.login } : null,
            headRepository: headRepository ? { nameWithOwner: headRepository.full_name } : null,
            mergeStateStatus: pr.mergeable_state.toUpperCase(),
            baseRef: {
              branchProtectionRule: protection
                ? {
                    requiredApprovingReviewCount: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
                    requiredStatusCheckContexts: protection.required_status_checks?.contexts ?? null,
                    requiredStatusChecks: checkRows?.map((check) => ({
                      context: check.context,
                      app: check.app_id === null ? null : { databaseId: check.app_id },
                    })) ?? null,
                  }
                : null,
            },
          },
        },
      },
    });
  });
}
