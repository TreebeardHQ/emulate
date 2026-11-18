import { describe, it, expect } from "vitest";
import { Hono, Store, WebhookDispatcher, type AppEnv } from "@emulators/core";
import { stripePlugin, seedFromConfig } from "../index.js";

const base = "http://localhost:14000/stripe";
function setup() {
  const app = new Hono<AppEnv>();
  const store = new Store();
  const webhooks = new WebhookDispatcher();
  stripePlugin.register(app, store, webhooks, base);
  seedFromConfig(store, base, {
    customers: [{ id: "cus_acme" }],
    products: [{ name: "Starter" }],
    prices: [
      {
        id: "price_starter",
        product_name: "Starter",
        currency: "usd",
        unit_amount: 10000,
        recurring: { interval: "month" },
      },
    ],
  });
  return { app, store, webhooks };
}
async function checkout(app: Hono<AppEnv>, headers: Record<string, string> = {}) {
  const res = await app.request("/v1/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      mode: "subscription",
      customer: "cus_acme",
      line_items: [{ price: "price_starter", quantity: 1 }],
      subscription_data: { metadata: { orgId: "acme" } },
    }),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("subscription Checkout", () => {
  it("creates one active subscription with item periods, metadata and a paid invoice on completion", async () => {
    const { app } = setup();
    const session = await checkout(app);
    expect((await app.request("/v1/subscriptions?customer=cus_acme&status=all")).status).toBe(200);
    await app.request(`/checkout/${session.id}/complete`, { method: "POST" });
    await app.request(`/checkout/${session.id}/complete`, { method: "POST" });
    const list = await (await app.request("/v1/subscriptions?customer=cus_acme&status=all")).json();
    expect(list.data).toHaveLength(1);
    const sub = list.data[0];
    expect(sub).toMatchObject({
      object: "subscription",
      customer: "cus_acme",
      status: "active",
      metadata: { orgId: "acme" },
      cancel_at_period_end: false,
    });
    expect(sub.items.data[0]).toMatchObject({
      object: "subscription_item",
      quantity: 1,
      price: { id: "price_starter" },
    });
    expect(sub.items.data[0].current_period_end).toBeGreaterThan(sub.items.data[0].current_period_start);
    expect(sub.billing_cycle_anchor).toBe(sub.items.data[0].current_period_start);
    const detail = await (await app.request(`/v1/subscriptions/${sub.id}?expand[]=latest_invoice`)).json();
    expect(detail.latest_invoice).toMatchObject({
      object: "invoice",
      customer: "cus_acme",
      status: "paid",
      amount_paid: 10000,
    });
    expect((await (await app.request("/v1/subscriptions?customer=cus_other&status=all")).json()).data).toEqual([]);
    expect((await app.request("/v1/subscriptions/sub_missing")).status).toBe(404);
    const expanded = await (await app.request(`/v1/subscriptions/${sub.id}?expand[]=items.data.price.product`)).json();
    expect(expanded.items.data[0].price.product).toMatchObject({ object: "product", name: "Starter" });
    const second = await checkout(app);
    await Promise.all([
      app.request(`/checkout/${second.id}/complete`, { method: "POST" }),
      app.request(`/checkout/${second.id}/complete`, { method: "POST" }),
    ]);
    const page = await (await app.request("/v1/subscriptions?customer=cus_acme&status=all&limit=1")).json();
    expect(page.has_more).toBe(true);
    const last = await (
      await app.request(`/v1/subscriptions?customer=cus_acme&status=all&limit=1&starting_after=${page.data[0].id}`)
    ).json();
    expect(last.has_more).toBe(false);
    expect(last.data[0].id).toBe(sub.id);
    expect((await (await app.request(`/v1/checkout/sessions/${session.id}`)).json()).subscription).toBe(sub.id);
  });
});

describe("subscription events", () => {
  it("delivers signed Stripe envelopes for creation, updates, deletion and invoice outcomes", async () => {
    const { app, webhooks } = setup();
    const captured: Array<{ raw: string; signature: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_input, init) => {
      captured.push({ raw: String(init?.body), signature: new Headers(init?.headers).get("stripe-signature")! });
      return new Response(null, { status: 200 });
    };
    try {
      seedFromConfig(
        new Store(),
        base,
        {
          webhooks: [
            { url: "https://app.example.com/webhooks/stripe", events: ["*"], secret: "synthetic-signing-secret" },
          ],
        },
        webhooks,
      );
      const session = await checkout(app);
      await app.request(`/checkout/${session.id}/complete`, { method: "POST" });
      const {
        data: [sub],
      } = await (await app.request("/v1/subscriptions?status=all")).json();
      const update = await app.request(`/v1/subscriptions/${sub.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "cancel_at_period_end=true",
      });
      expect((await update.json()).cancel_at_period_end).toBe(true);
      expect(
        (
          await app.request(`/v1/invoices/${sub.latest_invoice}/pay`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ payment_method: "pm_card_chargeDeclined" }),
          })
        ).status,
      ).toBe(402);
      await app.request(`/v1/invoices/${sub.latest_invoice}/pay`, { method: "POST" });
      expect((await (await app.request(`/v1/subscriptions/${sub.id}`, { method: "DELETE" })).json()).status).toBe(
        "canceled",
      );
      const events = captured.map(({ raw }) => JSON.parse(raw));
      expect(events.map((e) => e.type)).toEqual([
        "customer.subscription.created",
        "invoice.paid",
        "checkout.session.completed",
        "customer.subscription.updated",
        "invoice.payment_failed",
        "invoice.paid",
        "customer.subscription.deleted",
      ]);
      expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
      for (const [i, event] of events.entries()) {
        expect(event).toMatchObject({ object: "event", livemode: false, data: { object: { customer: "cus_acme" } } });
        const { raw, signature } = captured[i];
        const timestamp = signature.split(",")[0].slice(2);
        const { createHmac } = await import("node:crypto");
        expect(signature).toBe(
          `t=${timestamp},v1=${createHmac("sha256", "synthetic-signing-secret").update(`${timestamp}.${raw}`).digest("hex")}`,
        );
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("billing portal", () => {
  it("returns an opaque hosted portal URL and cancels only that customer's subscription", async () => {
    const { app } = setup();
    const session = await checkout(app);
    await app.request(`/checkout/${session.id}/complete`, { method: "POST" });
    const {
      data: [sub],
    } = await (await app.request("/v1/subscriptions?status=all")).json();
    const res = await app.request("/v1/billing_portal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: "cus_acme", return_url: "https://app.example.com/settings/billing" }),
    });
    expect(res.status).toBe(200);
    const portal = await res.json();
    expect(portal.url).toBe(`${base}/portal/${portal.id}`);
    const page = await (await app.request(`/portal/${portal.id}`)).text();
    expect(page).toContain("Cancel at period end");
    expect(page).toContain("Cancel now");
    const scheduled = await app.request(`/portal/${portal.id}/cancel`, {
      method: "POST",
      body: new URLSearchParams({ subscription: sub.id, action: "schedule" }),
    });
    expect(scheduled.status).toBe(302);
    expect((await (await app.request(`/v1/subscriptions/${sub.id}`)).json()).cancel_at_period_end).toBe(true);
    await app.request(`/portal/${portal.id}/cancel`, {
      method: "POST",
      body: new URLSearchParams({ subscription: sub.id, action: "cancel_now" }),
    });
    expect((await (await app.request(`/v1/subscriptions/${sub.id}`)).json()).status).toBe("canceled");
    expect((await app.request("/portal/unknown")).status).toBe(404);
    expect(
      (
        await app.request(`/portal/${portal.id}/cancel`, {
          method: "POST",
          body: new URLSearchParams({ subscription: "sub_other", action: "cancel_now" }),
        })
      ).status,
    ).toBe(404);
  });
});

describe("Checkout idempotency", () => {
  it("replays the original response after completion and refuses different parameters", async () => {
    const { app } = setup();
    const first = await checkout(app, { "Idempotency-Key": "checkout-acme" });
    await app.request(`/checkout/${first.id}/complete`, { method: "POST" });
    expect(await checkout(app, { "Idempotency-Key": "checkout-acme" })).toEqual(first);
    const conflict = await app.request("/v1/checkout/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "checkout-acme" },
      body: JSON.stringify({ mode: "payment" }),
    });
    expect(conflict.status).toBe(400);
    const sessions = await (await app.request("/v1/checkout/sessions")).json();
    expect(sessions.data).toHaveLength(1);
  });
});

describe("public portal form safety", () => {
  it("does not traverse prototype properties in form field names", async () => {
    const { app } = setup();
    const res = await app.request("/v1/billing_portal/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customer: "cus_acme", return_url: "https://app.example.com" }),
    });
    const portal = await res.json();
    try {
      const response = await app.request(`/portal/${portal.id}/cancel`, {
        method: "POST",
        body: new URLSearchParams({ "__proto__[stripePrototypeProbe]": "yes" }),
      });
      expect(response.status).toBe(404);
      expect(Object.hasOwn(Object.prototype, "stripePrototypeProbe")).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, "stripePrototypeProbe");
    }
  });
});

describe("subscription reset and terminal state", () => {
  it("does not replay a removed Checkout session after the upstream store resets", async () => {
    const { app, store } = setup();
    const first = await checkout(app, { "Idempotency-Key": "reset-acme" });
    store.reset();
    seedFromConfig(store, base, {
      customers: [{ id: "cus_acme" }],
      products: [{ name: "Starter" }],
      prices: [{ id: "price_starter", product_name: "Starter", currency: "usd", unit_amount: 10000 }],
    });
    const second = await checkout(app, { "Idempotency-Key": "reset-acme" });
    expect(second.id).not.toBe(first.id);
    expect((await app.request(`/v1/checkout/sessions/${second.id}`)).status).toBe(200);
  });

  it("keeps canceled subscriptions canceled when an invoice is paid or fails", async () => {
    const { app } = setup();
    const session = await checkout(app);
    await app.request(`/checkout/${session.id}/complete`, { method: "POST" });
    const {
      data: [sub],
    } = await (await app.request("/v1/subscriptions?status=all")).json();
    await app.request(`/v1/subscriptions/${sub.id}`, { method: "DELETE" });
    for (const body of [{}, { payment_method: "pm_card_chargeDeclined" }]) {
      await app.request(`/v1/invoices/${sub.latest_invoice}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect((await (await app.request(`/v1/subscriptions/${sub.id}`)).json()).status).toBe("canceled");
    }
  });
});
