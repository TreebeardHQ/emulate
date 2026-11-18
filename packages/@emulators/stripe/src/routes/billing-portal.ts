import { renderCardPage, escapeHtml, escapeAttr, type Entity, type RouteContext } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, parseStripeBody, stripeError } from "../helpers.js";
import {
  createPaidInvoice,
  dispatchStripeEvent,
  formatInvoice,
  formatSubscription,
  subscriptionPeriodEnd,
} from "../subscriptions.js";

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
      </form>
      <form method="post" action="${escapeAttr(baseUrl)}/portal/${escapeAttr(portal.stripe_id)}/update">
        <input type="hidden" name="subscription" value="${escapeAttr(sub.stripe_id)}">
        <select name="price" aria-label="Subscription price">${ss.prices
          .all()
          .filter((price) => price.active && price.recurring && price.stripe_id !== sub.items[0].price)
          .map(
            (price) =>
              `<option value="${escapeAttr(price.stripe_id)}">${escapeHtml(ss.products.findOneBy("stripe_id", price.product_id)!.name)}: ${escapeHtml(price.currency.toUpperCase())} ${((price.unit_amount ?? 0) / 100).toFixed(2)} / ${price.recurring!.interval}</option>`,
          )
          .join("")}</select>
        <button class="inspector-action" type="submit">Update subscription</button>
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
  app.post("/portal/:id/update", async (c) => {
    const portal = portals.findOneBy("stripe_id", c.req.param("id"));
    if (!portal) return c.notFound();
    const fields = new URLSearchParams(await c.req.text());
    const sub = ss.subscriptions.findOneBy("stripe_id", fields.get("subscription") ?? "");
    if (!sub || sub.customer_id !== portal.customer) return c.notFound();
    if (sub.status === "canceled") return c.redirect(portal.return_url);
    const price = ss.prices.findOneBy("stripe_id", fields.get("price") ?? "");
    if (!price?.active || !price.recurring || sub.items.length !== 1) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Select an active recurring price for a single-item subscription",
      );
    }
    const item = sub.items[0];
    if (item.price === price.stripe_id) return c.redirect(portal.return_url);
    const previousPrice = ss.prices.findOneBy("stripe_id", item.price)!;
    if (price.currency !== previousPrice.currency) {
      return stripeError(c, 400, "invalid_request_error", "The subscription currency cannot change");
    }
    if (!previousPrice.recurring) {
      return stripeError(c, 400, "invalid_request_error", "The subscription's current price is not recurring");
    }
    const start = Math.floor(Date.now() / 1000);
    const intervalChanged = previousPrice.recurring.interval !== price.recurring.interval;
    const updated = ss.subscriptions.update(sub.id, {
      items: [{ ...item, price: price.stripe_id }],
      // A switch replaces the plan, so a scheduled cancellation is cleared.
      cancel_at_period_end: false,
      latest_invoice: stripeId("in"),
      ...(intervalChanged
        ? {
            current_period_start: start,
            current_period_end: subscriptionPeriodEnd(start, price.recurring.interval),
          }
        : {}),
    })!;
    // Prorations and unused-time credits are not modeled; invoice the full new price.
    const invoice = createPaidInvoice(updated, ss);
    await dispatchStripeEvent(webhooks, "customer.subscription.updated", formatSubscription(updated, ss));
    await dispatchStripeEvent(webhooks, "invoice.paid", formatInvoice(invoice));
    return c.redirect(portal.return_url);
  });
  app.post("/portal/:id/cancel", async (c) => {
    const portal = portals.findOneBy("stripe_id", c.req.param("id"));
    if (!portal) return c.notFound();
    const fields = new URLSearchParams(await c.req.text());
    const body = { subscription: fields.get("subscription"), action: fields.get("action") };
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
