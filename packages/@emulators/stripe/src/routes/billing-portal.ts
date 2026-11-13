import { renderCardPage, escapeHtml, escapeAttr, type Entity, type RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError } from "../helpers.js";
import { dispatchStripeEvent, formatSubscription } from "../subscriptions.js";

interface PortalSession extends Entity {
  stripe_id: string;
  customer: string;
  return_url: string;
}

export function billingPortalRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);
  const portals = store.collection<PortalSession>("stripe.portal_sessions", ["stripe_id"]);
  app.post("/v1/billing_portal/sessions", async (c) => {
    const body = await parseStripeBody(c);
    if (typeof body.customer !== "string" || !ss.customers.findOneBy("stripe_id", body.customer)) {
      return stripeError(c, 400, "invalid_request_error", "No such customer", "resource_missing");
    }
    if (typeof body.return_url !== "string" || !/^https?:\/\//.test(body.return_url)) {
      return stripeError(c, 400, "invalid_request_error", "return_url must be an HTTP(S) URL");
    }
    const portal = portals.insert({ stripe_id: stripeId("bps"), customer: body.customer, return_url: body.return_url });
    return c.json({
      id: portal.stripe_id,
      object: "billing_portal.session",
      customer: portal.customer,
      return_url: portal.return_url,
      url: `${baseUrl}/portal/${portal.stripe_id}`,
    });
  });
  app.get("/portal/:id", (c) => {
    const portal = portals.findOneBy("stripe_id", c.req.param("id"));
    if (!portal) return c.notFound();
    const subscriptions = ss.subscriptions.all().filter((sub) => sub.customer_id === portal.customer);
    const content = subscriptions
      .map(
        (sub) =>
          `<div class="s-card"><p>${escapeHtml(sub.stripe_id)}: ${escapeHtml(sub.status)}</p>${
            sub.status === "canceled"
              ? ""
              : `
      <form method="post" action="${escapeAttr(baseUrl)}/portal/${escapeAttr(portal.stripe_id)}/cancel">
        <input type="hidden" name="subscription" value="${escapeAttr(sub.stripe_id)}">
        <button class="inspector-action" name="action" value="schedule">Cancel at period end</button>
        <button class="inspector-action" name="action" value="cancel_now">Cancel now</button>
      </form>`
          }</div>`,
      )
      .join("");
    return c.html(
      renderCardPage(
        "Billing portal",
        "Manage your subscription",
        `${content}<p><a href="${escapeAttr(portal.return_url)}">Return to application</a></p>`,
        "Stripe",
      ),
    );
  });
  app.post("/portal/:id/cancel", async (c) => {
    const portal = portals.findOneBy("stripe_id", c.req.param("id"));
    if (!portal) return c.notFound();
    const body = await parseStripeBody(c);
    const sub =
      typeof body.subscription === "string" ? ss.subscriptions.findOneBy("stripe_id", body.subscription) : undefined;
    if (!sub || sub.customer_id !== portal.customer) return c.notFound();
    if (body.action !== "schedule" && body.action !== "cancel_now")
      return stripeError(c, 400, "invalid_request_error", "Unknown cancellation action");
    if (sub.status === "canceled") return c.redirect(portal.return_url);
    const now = body.action === "cancel_now";
    const updated = ss.subscriptions.update(sub.id, {
      status: now ? "canceled" : sub.status,
      cancel_at_period_end: !now,
    })!;
    await dispatchStripeEvent(
      webhooks,
      now ? "customer.subscription.deleted" : "customer.subscription.updated",
      formatSubscription(updated, ss),
    );
    return c.redirect(portal.return_url);
  });
}
