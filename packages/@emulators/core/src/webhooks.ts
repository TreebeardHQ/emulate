import { createHash, createHmac } from "crypto";

export interface WebhookSubscription {
  id: number;
  url: string;
  events: string[];
  active: boolean;
  secret?: string;
  owner: string;
  repo?: string;
}

export interface WebhookDelivery {
  id: number;
  delivery_id: string;
  hook_id: number;
  event: string;
  action?: string;
  payload: unknown;
  status_code: number | null;
  delivered_at: string;
  duration: number | null;
  success: boolean;
  redelivery_of?: number;
  redelivery_count?: number;
}

export interface WebhookHeaderContext {
  event: string;
  action?: string;
  body: string;
  subscription: Readonly<WebhookSubscription>;
  deliveryId: number;
  deliveryGuid: string;
}

export type WebhookHeaderFactory = (context: WebhookHeaderContext) => Record<string, string>;
export type WebhookDeliveryObserver = (delivery: Readonly<WebhookDelivery>) => void;

const MAX_DELIVERIES = 1000;

function githubHeaders({ event, body, subscription, deliveryGuid }: WebhookHeaderContext): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": deliveryGuid,
  };

  if (subscription.secret) {
    const hmac = createHmac("sha256", subscription.secret).update(body).digest("hex");
    headers["X-Hub-Signature-256"] = `sha256=${hmac}`;
  }

  return headers;
}

export class WebhookDispatcher {
  constructor(private readonly options: { signal?: AbortSignal; neutral?: boolean } = {}) {
    if (options.neutral) this.headerFactory = () => ({ "Content-Type": "application/json" });
  }
  private subscriptions: WebhookSubscription[] = [];
  private directSubscriptions = new Map<number, WebhookSubscription>();
  private directSubscriptionKeys = new Map<string, number>();
  private deliverySequence = 0;
  private deliveries: WebhookDelivery[] = [];
  private subscriptionIdCounter = 1;
  private deliveryIdCounter = 1;
  private headerFactory: WebhookHeaderFactory = githubHeaders;
  private deliveryObservers = new Set<WebhookDeliveryObserver>();

  setHeaderFactory(factory: WebhookHeaderFactory): void {
    this.headerFactory = factory;
  }

  observeDeliveries(observer: WebhookDeliveryObserver): () => void {
    this.deliveryObservers.add(observer);
    return () => this.deliveryObservers.delete(observer);
  }

  register(sub: Omit<WebhookSubscription, "id"> & { id?: number }): WebhookSubscription {
    const { id: explicitId, ...rest } = sub;
    const id = explicitId !== undefined ? explicitId : this.subscriptionIdCounter++;
    if (id >= this.subscriptionIdCounter) {
      this.subscriptionIdCounter = id + 1;
    }
    const subscription: WebhookSubscription = { ...rest, id };
    this.subscriptions.push(subscription);
    return subscription;
  }

  unregister(id: number): boolean {
    const idx = this.subscriptions.findIndex((s) => s.id === id);
    if (idx === -1) return false;
    this.subscriptions.splice(idx, 1);
    return true;
  }

  getSubscription(id: number): WebhookSubscription | undefined {
    return this.subscriptions.find((s) => s.id === id);
  }

  getSubscriptions(owner?: string, repo?: string): WebhookSubscription[] {
    return this.subscriptions.filter((s) => {
      if (owner && s.owner !== owner) return false;
      if (repo !== undefined && s.repo !== repo) return false;
      return true;
    });
  }

  updateSubscription(
    id: number,
    data: Partial<Pick<WebhookSubscription, "url" | "events" | "active" | "secret">>,
  ): WebhookSubscription | undefined {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (!sub) return undefined;
    Object.assign(sub, data);
    return sub;
  }

  async dispatch(
    event: string,
    action: string | undefined,
    payload: unknown,
    owner: string,
    repo?: string,
  ): Promise<void> {
    const matchingSubs = this.subscriptions.filter((s) => {
      if (!s.active) return false;
      if (s.owner !== owner) return false;
      if (repo !== undefined) {
        if (s.repo !== repo) return false;
      } else if (s.repo !== undefined) {
        return false;
      }
      return event === "ping" || s.events.includes("*") || s.events.includes(event);
    });

    for (const sub of matchingSubs) {
      await this.deliver(sub, event, action, payload);
    }
  }

  async redeliver(
    deliveryId: number,
    options: { headers?: Record<string, string> } = {},
  ): Promise<WebhookDelivery | undefined> {
    const original = this.deliveries.find((delivery) => delivery.id === deliveryId);
    if (!original) return undefined;
    const sub = this.getSubscription(original.hook_id) ?? this.directSubscriptions.get(original.hook_id);
    if (!sub?.active) return undefined;
    return this.deliver(sub, original.event, original.action, original.payload, {
      headers: { "X-GitHub-Delivery": original.delivery_id, ...options.headers },
      redelivery_of: original.id,
      redelivery_count: (original.redelivery_count ?? 0) + 1,
      delivery_id: original.delivery_id,
    });
  }

  async deliverDirect(
    subscription: Omit<WebhookSubscription, "id">,
    event: string,
    action: string | undefined,
    payload: unknown,
  ): Promise<WebhookDelivery> {
    const key = createHash("sha256").update(JSON.stringify(subscription)).digest("hex");
    let id = this.directSubscriptionKeys.get(key);
    if (id === undefined) {
      id = this.subscriptionIdCounter++;
      this.directSubscriptionKeys.set(key, id);
      this.directSubscriptions.set(id, { ...subscription, id });
    }
    const sub = this.directSubscriptions.get(id)!;
    return this.deliver(sub, event, action, payload);
  }

  private async deliver(
    sub: WebhookSubscription,
    event: string,
    action: string | undefined,
    payload: unknown,
    options: { headers?: Record<string, string>; redelivery_of?: number; redelivery_count?: number; delivery_id?: string } = {},
  ): Promise<WebhookDelivery> {
    const body = JSON.stringify(payload);
    const occurrence = ++this.deliverySequence;
    const deliveryGuid = options.delivery_id ?? createHash("sha256")
      .update(JSON.stringify({ hook: sub.id, event, action: action ?? null, payload, occurrence }))
      .digest("hex")
      .replace(/^([0-9a-f]{8})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{4})([0-9a-f]{12}).*$/, "$1-$2-$3-$4-$5");
    const delivery: WebhookDelivery = {
      id: this.deliveryIdCounter++,
      delivery_id: deliveryGuid,
      hook_id: sub.id,
      event,
      action,
      payload: body === undefined ? undefined : JSON.parse(body),
      status_code: null,
      delivered_at: new Date().toISOString(),
      duration: null,
      success: false,
      ...(options.redelivery_of !== undefined
        ? { redelivery_of: options.redelivery_of, redelivery_count: options.redelivery_count }
        : {}),
    };

    // Reserve the attempt before sending so concurrent retries can see it.
    this.deliveries.push(delivery);
    if (this.deliveries.length > MAX_DELIVERIES) {
      this.deliveries.splice(0, this.deliveries.length - MAX_DELIVERIES);
    }

    try {
      const headers = {
        ...this.headerFactory({ event, action, body, subscription: sub, deliveryId: delivery.id, deliveryGuid }),
        ...options.headers,
      };
      const start = Date.now();
      const response = await fetch(sub.url, {
        method: "POST",
        headers,
        body,
        signal: this.options.signal
          ? AbortSignal.any([this.options.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
      delivery.duration = Date.now() - start;
      delivery.status_code = response.status;
      delivery.success = response.ok;
    } catch {
      delivery.duration = 0;
      delivery.success = false;
    }
    for (const observer of this.deliveryObservers) observer(structuredClone(delivery));
    return delivery;
  }

  getDeliveries(hookId?: number): WebhookDelivery[] {
    if (hookId !== undefined) {
      return this.deliveries.filter((d) => d.hook_id === hookId);
    }
    return [...this.deliveries];
  }

  clear(): void {
    this.subscriptions.length = 0;
    this.directSubscriptions.clear();
    this.directSubscriptionKeys.clear();
    this.deliverySequence = 0;
    this.deliveries.length = 0;
    this.deliveryObservers.clear();
    this.subscriptionIdCounter = 1;
    this.deliveryIdCounter = 1;
  }
}
