import type { Entity, RouteContext } from "@emulators/core";
import { renderCardPage, renderCheckoutPage, escapeHtml, escapeAttr } from "@emulators/core";
import type { CheckoutLineItem } from "@emulators/core";
import { getStripeStore } from "../store.js";
import { stripeId, toUnixTimestamp, parseStripeBody, stripeError, stripeList, stripeRequestKey } from "../helpers.js";
import { completeSubscription, dispatchStripeEvent } from "../subscriptions.js";
import type { StripeCheckoutSession } from "../entities.js";

const SERVICE_LABEL = "Stripe";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

function formatSession(s: StripeCheckoutSession, baseUrl: string) {
  return {
    id: s.stripe_id,
    object: "checkout.session",
    mode: s.mode,
    status: s.status,
    payment_status: s.payment_status,
    customer: s.customer_id,
    subscription: s.subscription_id ?? null,
    success_url: s.success_url,
    cancel_url: s.cancel_url,
    metadata: s.metadata,
    created: toUnixTimestamp(s.created_at),
    livemode: false,
    url: s.status === "open" ? `${baseUrl}/checkout/${s.stripe_id}` : null,
  };
}

export function checkoutSessionRoutes({ app, store, webhooks, baseUrl }: RouteContext): void {
  const ss = getStripeStore(store);

  interface CheckoutReplay extends Entity {
    scope: string;
    params: string;
    response: ReturnType<typeof formatSession>;
  }
  const replays = store.collection<CheckoutReplay>("stripe.checkout_replays", ["scope"]);

  app.post("/v1/checkout/sessions", async (c) => {
    const body = await parseStripeBody(c);
    const key = c.req.header("Idempotency-Key");
    const scope = JSON.stringify([stripeRequestKey(c.req.header("Authorization")), key]);
    const params = JSON.stringify(canonical(body));
    const replay = key ? replays.findOneBy("scope", scope) : undefined;
    if (replay) {
      if (replay.params !== params)
        return stripeError(
          c,
          400,
          "invalid_request_error",
          "Idempotency-Key was reused with different parameters.",
          "idempotency_key_in_use",
        );
      return c.json(replay.response);
    }
    if (!body.mode)
      return stripeError(c, 400, "invalid_request_error", "Missing required param: mode.", undefined, "mode");

    if (body.customer && !ss.customers.findOneBy("stripe_id", body.customer as string)) {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        `No such customer: '${body.customer}'`,
        "resource_missing",
        "customer",
      );
    }

    const lineItems: Array<{ price: string; quantity: number }> = [];
    if (body.line_items) {
      if (!Array.isArray(body.line_items)) {
        return stripeError(c, 400, "invalid_request_error", "line_items must be an array.", undefined, "line_items");
      }
      for (let i = 0; i < body.line_items.length; i++) {
        const li = body.line_items[i] as Record<string, unknown>;
        if (!li || typeof li !== "object") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}]: must be an object.`,
            undefined,
            `line_items[${i}]`,
          );
        }
        if (!li.price || typeof li.price !== "string") {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Missing required param: line_items[${i}][price].`,
            undefined,
            `line_items[${i}][price]`,
          );
        }
        if (!ss.prices.findOneBy("stripe_id", li.price)) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `No such price: '${li.price}'`,
            "resource_missing",
            `line_items[${i}][price]`,
          );
        }
        const qty = typeof li.quantity === "number" ? li.quantity : parseInt(li.quantity as string, 10);
        if (!Number.isFinite(qty) || qty < 1) {
          return stripeError(
            c,
            400,
            "invalid_request_error",
            `Invalid line_items[${i}][quantity]: must be a positive integer.`,
            undefined,
            `line_items[${i}][quantity]`,
          );
        }
        lineItems.push({ price: li.price, quantity: qty });
      }
    }

    if (body.mode === "subscription" && (!body.customer || lineItems.length === 0)) {
      return stripeError(c, 400, "invalid_request_error", "Subscription Checkout requires a customer and line_items.");
    }
    const session = ss.checkoutSessions.insert({
      stripe_id: stripeId("cs"),
      mode: body.mode as StripeCheckoutSession["mode"],
      status: "open",
      payment_status: "unpaid",
      customer_id: (body.customer as string) ?? null,
      success_url: (body.success_url as string) ?? null,
      cancel_url: (body.cancel_url as string) ?? null,
      line_items: lineItems,
      subscription_metadata:
        (body.subscription_data as { metadata?: Record<string, string> } | undefined)?.metadata ?? {},
      metadata: (body.metadata as Record<string, string>) ?? {},
    });
    const response = formatSession(session, baseUrl);
    if (key) replays.insert({ scope, params, response });
    return c.json(response, 200);
  });

  app.get("/v1/checkout/sessions/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    return c.json(formatSession(session, baseUrl));
  });

  app.post("/v1/checkout/sessions/:id/expire", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session)
      return stripeError(
        c,
        404,
        "invalid_request_error",
        `No such checkout session: '${c.req.param("id")}'`,
        "resource_missing",
      );
    if (session.status !== "open") {
      return stripeError(
        c,
        400,
        "invalid_request_error",
        "Only open sessions can be expired.",
        "checkout_session_not_open",
      );
    }
    const updated = ss.checkoutSessions.update(session.id, { status: "expired" })!;

    await webhooks.dispatch(
      "checkout.session.expired",
      undefined,
      { type: "checkout.session.expired", data: { object: formatSession(updated, baseUrl) } },
      "stripe",
    );

    return c.json(formatSession(updated, baseUrl));
  });

  app.get("/v1/checkout/sessions", (c) => {
    let items = ss.checkoutSessions.all();
    const customerId = c.req.query("customer");
    const status = c.req.query("status");
    const paymentStatus = c.req.query("payment_status");
    if (customerId) items = items.filter((s) => s.customer_id === customerId);
    if (status) items = items.filter((s) => s.status === status);
    if (paymentStatus) items = items.filter((s) => s.payment_status === paymentStatus);
    return stripeList(c, items, "/v1/checkout/sessions", (s) => formatSession(s, baseUrl));
  });

  app.get("/checkout/:id", (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session) {
      return c.html(
        renderCardPage(
          "Session Not Found",
          "This checkout session does not exist.",
          '<p class="empty">The session ID is invalid or has been removed.</p>',
          SERVICE_LABEL,
        ),
        404,
      );
    }
    if (session.status !== "open") {
      return c.html(
        renderCardPage(
          "Session Expired",
          "This checkout session is no longer available.",
          `<p class="empty">Status: ${escapeHtml(session.status)}</p>`,
          SERVICE_LABEL,
        ),
      );
    }

    const lineItems: CheckoutLineItem[] = session.line_items.map((li) => {
      const priceObj = ss.prices.findOneBy("stripe_id", li.price);
      const product = priceObj ? ss.products.findOneBy("stripe_id", priceObj.product_id) : null;
      const unitPrice = priceObj?.unit_amount ?? 0;
      return {
        name: product?.name ?? li.price,
        quantity: li.quantity,
        unitPrice,
        totalPrice: unitPrice * li.quantity,
        currency: priceObj?.currency ?? "usd",
      };
    });

    const subtotal = lineItems.reduce((sum, li) => sum + li.totalPrice, 0);
    const currency = lineItems.length > 0 ? lineItems[0].currency : "usd";

    return c.html(
      renderCheckoutPage(
        {
          lineItems,
          subtotal,
          total: subtotal,
          currency,
          sessionId: session.stripe_id,
          cancelUrl: session.cancel_url,
        },
        SERVICE_LABEL,
      ),
    );
  });

  app.post("/checkout/:id/complete", async (c) => {
    const session = ss.checkoutSessions.findOneBy("stripe_id", c.req.param("id"));
    if (!session || session.status !== "open") {
      return c.redirect("/checkout/" + c.req.param("id"));
    }

    ss.checkoutSessions.update(session.id, { status: "complete", payment_status: "paid" });
    const subscription =
      session.mode === "subscription"
        ? await completeSubscription({ app, store, webhooks, baseUrl }, session)
        : undefined;
    const updated = ss.checkoutSessions.update(session.id, {
      status: "complete",
      payment_status: "paid",
      ...(subscription ? { subscription_id: subscription.stripe_id } : {}),
    })!;

    await dispatchStripeEvent(webhooks, "checkout.session.completed", formatSession(updated, baseUrl));

    if (session.success_url) {
      const url = session.success_url.replace("{CHECKOUT_SESSION_ID}", updated.stripe_id);
      return c.redirect(url);
    }

    return c.html(
      renderCardPage(
        "Payment Complete",
        "Your payment was successful.",
        '<p class="empty check">Payment received</p>',
        SERVICE_LABEL,
      ),
    );
  });
}
