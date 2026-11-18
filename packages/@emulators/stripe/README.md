# @emulators/stripe

Stripe API emulation with customers, payment methods, customer sessions, payment intents, charges, products, prices, and checkout sessions. Includes a hosted checkout page and webhook delivery.

Part of [emulate](https://github.com/vercel-labs/emulate) — local drop-in replacement services for CI and no-network sandboxes.

## Install

```bash
npm install @emulators/stripe
```

## Endpoints

### Customers
- `POST /v1/customers` — create customer
- `GET /v1/customers/:id` — retrieve customer
- `POST /v1/customers/:id` — update customer
- `DELETE /v1/customers/:id` — delete customer
- `GET /v1/customers` — list customers

### Payment Methods
- `GET /v1/payment_methods` — list payment methods

### Customer Sessions
- `POST /v1/customer_sessions` — create customer session

### Payment Intents
- `POST /v1/payment_intents` — create payment intent
- `GET /v1/payment_intents/:id` — retrieve payment intent
- `POST /v1/payment_intents/:id` — update payment intent
- `POST /v1/payment_intents/:id/confirm` — confirm payment intent
- `POST /v1/payment_intents/:id/cancel` — cancel payment intent
- `GET /v1/payment_intents` — list payment intents

### Charges
- `GET /v1/charges/:id` — retrieve charge
- `GET /v1/charges` — list charges

### Products
- `POST /v1/products` — create product
- `GET /v1/products/:id` — retrieve product
- `GET /v1/products` — list products

### Prices
- `POST /v1/prices` — create price
- `GET /v1/prices/:id` — retrieve price
- `GET /v1/prices` — list prices

### Checkout Sessions
- `POST /v1/checkout/sessions` — create checkout session
- `GET /v1/checkout/sessions/:id` — retrieve session
- `POST /v1/checkout/sessions/:id/expire` — expire session
- `GET /v1/checkout/sessions` — list sessions (filter by `customer`, `status`, `payment_status`)
- `GET /checkout/:id` — hosted checkout page (HTML)
- `POST /checkout/:id/complete` — complete payment flow

## Webhooks

Events are delivered to configured webhook URLs:
- Webhooks configured with a secret include `Stripe-Signature: t=<timestamp>,v1=<signature>`, signed over `<timestamp>.<raw body>`
- `checkout.session.completed` — when a checkout session is completed
- `checkout.session.expired` — when a checkout session expires

## Seed Configuration

```yaml
stripe:
  customers:
    - name: Test Customer
      email: test@example.com
  products:
    - name: Pro Plan
  prices:
    - product_name: Pro Plan
      unit_amount: 2000
      currency: usd
      recurring:
        interval: month
```

Recurring prices accept `month` or `year`. Monthly subscription periods remain 30 days. Yearly prices use the same UTC date next year, with February 29 clamped to February 28.

The portal switches single-item subscriptions between active recurring prices in the same currency. An interval change starts a new term immediately and invoices the full new price; prorations are not modeled. Every price change creates a full-price paid invoice, clears any scheduled cancellation, and emits `customer.subscription.updated` and `invoice.paid`. The subscription's `billing_cycle_anchor` is the start of its first term and does not change on a switch. A price change within the same interval preserves the term.

## Links

- [Full documentation](https://emulate.dev)
- [GitHub](https://github.com/vercel-labs/emulate)
