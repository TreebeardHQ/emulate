import type { RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeError, stripeList, parseExpand, parseStripeBody } from "../helpers.js";
import { formatSubscription, formatInvoice, dispatchStripeEvent } from "../subscriptions.js";

export function subscriptionRoutes({ app, store, webhooks }: RouteContext): void {
  const ss = getStripeStore(store);
  app.get("/v1/subscriptions", (c) => {
    const customer = c.req.query("customer");
    const status = c.req.query("status") ?? "active";
    const expand = parseExpand(c).map((path) => path.replace(/^data\./, ""));
    const items = ss.subscriptions
      .all()
      .filter((sub) => (!customer || sub.customer_id === customer) && (status === "all" || sub.status === status));
    return stripeList(c, items, "/v1/subscriptions", (sub) => formatSubscription(sub, ss, expand));
  });
  app.get("/v1/subscriptions/:id", (c) => {
    const sub = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!sub) return stripeError(c, 404, "invalid_request_error", "No such subscription", "resource_missing");
    return c.json(formatSubscription(sub, ss, parseExpand(c)));
  });
  app.post("/v1/subscriptions/:id", async (c) => {
    const sub = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!sub) return stripeError(c, 404, "invalid_request_error", "No such subscription", "resource_missing");
    const body = await parseStripeBody(c);
    if (body.cancel_at_period_end !== undefined) {
      if (![true, false, "true", "false"].includes(body.cancel_at_period_end as boolean | string)) {
        return stripeError(c, 400, "invalid_request_error", "cancel_at_period_end must be a boolean");
      }
      ss.subscriptions.update(sub.id, {
        cancel_at_period_end: body.cancel_at_period_end === true || body.cancel_at_period_end === "true",
      });
    }
    const updated = ss.subscriptions.findOneBy("stripe_id", sub.stripe_id)!;
    await dispatchStripeEvent(webhooks, "customer.subscription.updated", formatSubscription(updated, ss));
    return c.json(formatSubscription(updated, ss));
  });
  app.delete("/v1/subscriptions/:id", async (c) => {
    const sub = ss.subscriptions.findOneBy("stripe_id", c.req.param("id"));
    if (!sub) return stripeError(c, 404, "invalid_request_error", "No such subscription", "resource_missing");
    const updated = ss.subscriptions.update(sub.id, { status: "canceled", cancel_at_period_end: false })!;
    await dispatchStripeEvent(webhooks, "customer.subscription.deleted", formatSubscription(updated, ss));
    return c.json(formatSubscription(updated, ss));
  });
  app.post("/v1/invoices/:id/pay", async (c) => {
    const invoice = ss.invoices.findOneBy("stripe_id", c.req.param("id"));
    if (!invoice) return stripeError(c, 404, "invalid_request_error", "No such invoice", "resource_missing");
    const body = await parseStripeBody(c);
    const failed = body.payment_method === "pm_card_chargeDeclined";
    const updated = ss.invoices.update(invoice.id, { status: failed ? "open" : "paid" })!;
    const sub = ss.subscriptions.findOneBy("stripe_id", invoice.subscription_id)!;
    ss.subscriptions.update(sub.id, { status: failed ? "past_due" : "active" });
    await dispatchStripeEvent(webhooks, failed ? "invoice.payment_failed" : "invoice.paid", formatInvoice(updated));
    if (failed) return stripeError(c, 402, "card_error", "Your card was declined.", "card_declined");
    return c.json(formatInvoice(updated));
  });
}
