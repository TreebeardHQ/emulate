import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeError, stripeList, parseExpand } from "../helpers.js";
import { formatSubscription } from "../subscriptions.js";

export function subscriptionRoutes({ app, store }: RouteContext): void {
  const ss = getStripeStore(store);
  app.get("/v1/subscriptions", (c) => {
    const customer = c.req.query("customer");
    const status = c.req.query("status") ?? "active";
    const expand = parseExpand(c).map((path) => path.replace(/^data\./, ""));
    const items = ss.subscriptions.all().filter((sub) => (!customer || sub.customer_id === customer) && (status === "all" || sub.status === status));
    return stripeList(c, items, "/v1/subscriptions", (sub) => formatSubscription(sub, ss, expand));
  });
  app.get("/v1/subscriptions/:id", (c) => {
    const sub = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!sub) return stripeError(c, 404, "invalid_request_error", "No such subscription", "resource_missing");
    return c.json(formatSubscription(sub, ss, parseExpand(c)));
  });
}
