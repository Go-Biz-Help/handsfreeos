import { OPEN_TTL_S } from './rules';

/**
 * The phone's `business_v1` subscriptions, one per business, kept in line with what's wanted (`wantedBusinesses`).
 *
 * PowerSync keeps each subscription on the phone with a time to live that counts from the last time the app held
 * it: a business is renewed while it's wanted and runs out once it isn't. Subscribing again replaces the time to
 * live, which is how a business that stops being kept gets the short one before it's let go, so it leaves within
 * minutes rather than 30 days.
 */

export const BUSINESS_STREAM = 'business_v1';
/**
 * Round six: what the business's add-ons keep for phones (a deal and its rows), subscribed beside `business_v1` with
 * the same parameters and time to live, so it comes and goes with the business. Its subscriptions are read through
 * `business_v1`'s: the two are always held together.
 */
export const RECORDS_STREAM = 'records_v1';
/** Every stream a business's subscription holds. */
export const BUSINESS_STREAMS = [BUSINESS_STREAM, RECORDS_STREAM] as const;

/** The parameters of a business's subscription, always built the same way (PowerSync compares them as JSON). */
export const businessParameters = (businessId: string) => ({ workspace_id: businessId });

export interface StreamHandle {
  unsubscribe(): void;
}

export interface SubscribedBusiness {
  readonly businessId: string;
  /** When it runs out unless renewed. */
  readonly expiresAt: Date | null;
}

export interface BusinessStreams {
  /** Subscribes to a business, or renews its subscription with this time to live, in seconds. */
  subscribe(businessId: string, ttlSeconds: number): Promise<StreamHandle>;
  /** Businesses subscribed to on this phone, including ones no handle holds any more. */
  subscribed(): Promise<readonly SubscribedBusiness[]>;
}

/**
 * The phone's `business_v1` subscriptions and when each runs out, read from PowerSync's own table. Its status can't
 * say: `SyncSubscriptionDescription.expiresAt` is an invalid date in @powersync/common 2.2.1, which reads the core's
 * microseconds (0.5.3) as seconds.
 */
export async function readBusinessSubscriptions(db: {
  getAll<T>(sql: string, parameters?: unknown[]): Promise<T[]>;
}): Promise<SubscribedBusiness[]> {
  const rows = await db.getAll<{ local_params: string; expires_at: number | null }>(
    `SELECT local_params, expires_at FROM ps_stream_subscriptions WHERE stream_name = ? AND ttl IS NOT NULL`,
    [BUSINESS_STREAM],
  );
  return rows.flatMap((row) => {
    const id = (JSON.parse(row.local_params) as { workspace_id?: unknown } | null)?.workspace_id;
    if (typeof id !== 'string') return [];
    return [
      {
        businessId: id,
        expiresAt: row.expires_at === null ? null : new Date(row.expires_at / 1000),
      },
    ];
  });
}

/** A subscription running out a little after the short time to live still counts as short. */
const SLACK_MS = 60_000;

export class BusinessSubscriptions {
  private readonly held = new Map<string, { handle: StreamHandle; ttl: number }>();

  constructor(
    private readonly streams: BusinessStreams,
    private readonly now: () => number = Date.now,
  ) {}

  /** The businesses this app holds a subscription for, and each one's time to live. */
  holding(): Map<string, number> {
    return new Map([...this.held].map(([id, { ttl }]) => [id, ttl]));
  }

  async apply(wanted: ReadonlyMap<string, number>): Promise<void> {
    for (const [id, ttl] of wanted) {
      const current = this.held.get(id);
      if (current?.ttl === ttl) continue;
      const handle = await this.streams.subscribe(id, ttl);
      this.held.set(id, { handle, ttl });
      current?.handle.unsubscribe();
    }
    for (const [id, current] of [...this.held]) {
      if (wanted.has(id)) continue;
      if (current.ttl > OPEN_TTL_S) await this.shorten(id);
      current.handle.unsubscribe();
      this.held.delete(id);
    }
    // Subscriptions left from before, such as a business no longer on the person's list, or keep switches lost with
    // the app's settings: nothing renews them, and none may stay for longer than the short time to live.
    for (const { businessId, expiresAt } of await this.streams.subscribed()) {
      if (wanted.has(businessId) || this.held.has(businessId) || !expiresAt) continue;
      if (expiresAt.getTime() > this.now() + OPEN_TTL_S * 1000 + SLACK_MS)
        await this.shorten(businessId);
    }
  }

  /** Lets every subscription go as it is, for a database that's closing. */
  releaseAll(): void {
    for (const { handle } of this.held.values()) handle.unsubscribe();
    this.held.clear();
  }

  private async shorten(businessId: string): Promise<void> {
    (await this.streams.subscribe(businessId, OPEN_TTL_S)).unsubscribe();
  }
}
