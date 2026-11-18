import type { RouteContext, WebhookDispatcher } from "@emulators/core";
import { getStripeStore, type StripeStore } from "./store.js";
import { stripeId, toUnixTimestamp } from "./helpers.js";
import type { StripeSubscription, StripeInvoice, StripeCheckoutSession } from "./entities.js";

export async function dispatchStripeEvent(webhooks: WebhookDispatcher, type: string, object: unknown): Promise<void> {
  await webhooks.dispatch(
    type,
    undefined,
    {
      id: stripeId("evt"),
      object: "event",
      type,
      api_version: "2026-08-26.dahlia",
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: { object },
      pending_webhooks: 1,
      request: null,
    },
    "stripe",
  );
}

export function formatInvoice(invoice: StripeInvoice) {
  return {
    id: invoice.stripe_id,
    object: "invoice",
    customer: invoice.customer_id,
    subscription: invoice.subscription_id,
    currency: invoice.currency,
    status: invoice.status,
    amount_due: invoice.amount,
    amount_paid: invoice.status === "paid" ? invoice.amount : 0,
    paid: invoice.status === "paid",
    created: toUnixTimestamp(invoice.created_at),
    livemode: false,
  };
}

export function formatSubscription(sub: StripeSubscription, ss: StripeStore, expand: string[] = []) {
  const invoice = ss.invoices.findOneBy("stripe_id", sub.latest_invoice);
  return {
    id: sub.stripe_id,
    object: "subscription",
    customer: sub.customer_id,
    status: sub.status,
    billing_cycle_anchor: sub.billing_cycle_anchor,
    cancel_at_period_end: sub.cancel_at_period_end,
    cancel_at: sub.cancel_at_period_end ? sub.current_period_end : null,
    created: toUnixTimestamp(sub.created_at),
    livemode: false,
    metadata: sub.metadata,
    latest_invoice: expand.includes("latest_invoice") && invoice ? formatInvoice(invoice) : sub.latest_invoice,
    items: {
      object: "list",
      has_more: false,
      url: `/v1/subscription_items?subscription=${sub.stripe_id}`,
      data: sub.items.map((item) => {
        const price = ss.prices.findOneBy("stripe_id", item.price)!;
        const product = ss.products.findOneBy("stripe_id", price.product_id)!;
        return {
          id: item.id,
          object: "subscription_item",
          subscription: sub.stripe_id,
          quantity: item.quantity,
          current_period_start: sub.current_period_start,
          current_period_end: sub.current_period_end,
          price: {
            id: price.stripe_id,
            object: "price",
            currency: price.currency,
            unit_amount: price.unit_amount,
            type: "recurring",
            recurring: price.recurring,
            product: expand.includes("items.data.price.product")
              ? { id: product.stripe_id, object: "product", name: product.name, active: product.active }
              : price.product_id,
          },
        };
      }),
    },
  };
}

export function subscriptionPeriodEnd(start: number, interval: "month" | "year"): number {
  if (interval === "month") return start + 30 * 24 * 60 * 60;
  const end = new Date(start * 1000);
  const month = end.getUTCMonth();
  end.setUTCFullYear(end.getUTCFullYear() + 1);
  // Stripe clamps a leap-day anniversary to the last day of February.
  if (end.getUTCMonth() !== month) end.setUTCDate(0);
  return end.getTime() / 1000;
}

export function createPaidInvoice(sub: StripeSubscription, ss: StripeStore): StripeInvoice {
  return ss.invoices.insert({
    stripe_id: sub.latest_invoice,
    customer_id: sub.customer_id,
    subscription_id: sub.stripe_id,
    status: "paid",
    currency: ss.prices.findOneBy("stripe_id", sub.items[0].price)!.currency,
    amount: sub.items.reduce(
      (sum, item) => sum + (ss.prices.findOneBy("stripe_id", item.price)!.unit_amount ?? 0) * item.quantity,
      0,
    ),
  });
}

export async function completeSubscription(
  ctx: RouteContext,
  session: StripeCheckoutSession,
): Promise<StripeSubscription> {
  const ss = getStripeStore(ctx.store);
  const start = Math.floor(Date.now() / 1000);
  const sub = ss.subscriptions.insert({
    stripe_id: stripeId("sub"),
    customer_id: session.customer_id!,
    status: "active",
    cancel_at_period_end: false,
    billing_cycle_anchor: start,
    current_period_start: start,
    current_period_end: subscriptionPeriodEnd(
      start,
      ss.prices.findOneBy("stripe_id", session.line_items[0].price)!.recurring!.interval,
    ),
    items: session.line_items.map((item) => ({ id: stripeId("si"), ...item })),
    metadata: session.subscription_metadata,
    latest_invoice: stripeId("in"),
  });
  const invoice = createPaidInvoice(sub, ss);
  await dispatchStripeEvent(ctx.webhooks, "customer.subscription.created", formatSubscription(sub, ss));
  await dispatchStripeEvent(ctx.webhooks, "invoice.paid", formatInvoice(invoice));
  return sub;
}
