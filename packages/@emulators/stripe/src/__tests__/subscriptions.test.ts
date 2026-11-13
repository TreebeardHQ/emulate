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
    prices: [{ id: "price_starter", product_name: "Starter", currency: "usd", unit_amount: 10000 }],
  });
  return { app, store, webhooks };
}
async function checkout(app: Hono<AppEnv>, headers: Record<string, string> = {}) {
  const res = await app.request("/v1/checkout/sessions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ mode: "subscription", customer: "cus_acme", line_items: [{ price: "price_starter", quantity: 1 }], subscription_data: { metadata: { orgId: "acme" } } }),
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
    expect(sub).toMatchObject({ object: "subscription", customer: "cus_acme", status: "active", metadata: { orgId: "acme" }, cancel_at_period_end: false });
    expect(sub.items.data[0]).toMatchObject({ object: "subscription_item", quantity: 1, price: { id: "price_starter" } });
    expect(sub.items.data[0].current_period_end).toBeGreaterThan(sub.items.data[0].current_period_start);
    const detail = await (await app.request(`/v1/subscriptions/${sub.id}?expand[]=latest_invoice`)).json();
    expect(detail.latest_invoice).toMatchObject({ object: "invoice", customer: "cus_acme", status: "paid", amount_paid: 10000 });
    expect((await (await app.request("/v1/subscriptions?customer=cus_other&status=all")).json()).data).toEqual([]);
    expect((await app.request("/v1/subscriptions/sub_missing")).status).toBe(404);
    expect((await (await app.request(`/v1/checkout/sessions/${session.id}`)).json()).subscription).toBe(sub.id);
  });
});
