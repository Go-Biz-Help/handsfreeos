/**
 * What a run knows, read fresh from the database (event payloads are too thin): the customer, the lead, the
 * appointment, the conversation, tags, the business and its links, plus the run's own context (trigger
 * values, AI results, how the last wait ended). Conditions and templates look values up synchronously, so a
 * caller first `need()`s the paths it will read and the records behind them load once.
 *
 * A test run's `assume` values (by variable or field path) win over everything.
 */
import {
  conditionFields,
  formatPhone,
  templateVars,
  evaluate,
  type AnyConditionGroup,
} from '@hfos/core/server';
import { rows, sql, type Tx } from '@hfos/db/client';
import { publicOrigin } from '../hosting/origin';

export interface RunRefs {
  readonly workspaceId: string;
  readonly personId: string | null;
  readonly leadId: string | null;
  readonly appointmentId: string | null;
  readonly conversationId: string | null;
}

export interface RunDataOptions {
  readonly timeZone: string;
  readonly webUrl: string;
  readonly workflowName: string;
  readonly context: Readonly<Record<string, unknown>>;
}

export interface PersonRecord {
  readonly id: string;
  readonly first_name: string;
  readonly last_name: string;
  readonly email: string | null;
  readonly phone_e164: string | null;
  readonly city: string | null;
  readonly source: string | null;
  readonly owner_user_id: string | null;
  readonly sms_consent: 'unknown' | 'opted_in' | 'opted_out';
  readonly created_at: Date;
  readonly archived_at: Date | null;
}

export interface LeadRecord {
  readonly id: string;
  readonly person_id: string | null;
  readonly title: string;
  readonly value_cents: number;
  readonly status: string;
  readonly pipeline_id: string;
  readonly stage_id: string;
  readonly assignee_user_id: string | null;
  readonly source: string | null;
  readonly next_action: string | null;
  readonly next_action_at: Date | null;
  readonly created_at: Date;
  readonly stage_entered_at: Date;
  readonly stage: string | null;
  readonly pipeline: string | null;
  readonly assignee_name: string | null;
}

export interface AppointmentRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly calendar_id: string;
  readonly service_id: string | null;
  readonly source: string;
  readonly starts_at: Date;
  readonly ends_at: Date;
  readonly location: { kind?: string; address?: string | null; meetingUrl?: string | null } | null;
  readonly calendar: string | null;
  readonly service: string | null;
  readonly staff_names: string | null;
}

export interface ConversationRecord {
  readonly id: string;
  readonly channel: 'sms' | 'email';
  readonly status: string;
  readonly assignee_user_id: string | null;
  readonly awaiting_reply_since: Date | null;
  readonly last_message: string | null;
}

interface Business {
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly review: string | null;
}

type Source =
  | 'person'
  | 'lead'
  | 'appointment'
  | 'conversation'
  | 'person_tags'
  | 'lead_tags'
  | 'business'
  | 'links';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const money = (cents: number) =>
  `$${(cents / 100).toLocaleString('en-US', { maximumFractionDigits: cents % 100 ? 2 : 0 })}`;

function sourcesOf(path: string): Source[] {
  const [head, key] = path.split('.');
  if (path === 'person.tags') return ['person_tags'];
  if (path === 'lead.tags') return ['lead_tags'];
  switch (head) {
    case 'person':
    case 'lead':
    case 'appointment':
    case 'conversation':
    case 'business':
      return [head];
    case 'links':
      return key === 'review' ? ['business'] : ['links'];
    default:
      return [];
  }
}

export class RunData {
  private refs: RunRefs;
  private readonly loaded = new Map<Source, unknown>();
  private bookingCalendarId: string | null = null;

  constructor(
    private readonly tx: Tx,
    refs: RunRefs,
    private readonly opts: RunDataOptions,
  ) {
    this.refs = refs;
  }

  get ids(): RunRefs {
    return this.refs;
  }

  /** Point at another record (a lead a step just created); what it read about the old one is dropped. */
  retarget(patch: Partial<Omit<RunRefs, 'workspaceId'>>): void {
    this.refs = { ...this.refs, ...patch };
    if ('leadId' in patch) {
      this.loaded.delete('lead');
      this.loaded.delete('lead_tags');
    }
    if ('conversationId' in patch) this.loaded.delete('conversation');
    if ('personId' in patch) this.loaded.clear();
  }

  /** The calendar whose booking page {{links.booking}} opens (null: the main one). */
  useBookingCalendar(calendarId: string | null): void {
    if (calendarId === this.bookingCalendarId) return;
    this.bookingCalendarId = calendarId;
    this.loaded.delete('links');
  }

  /** Loads what these paths read. */
  async need(paths: Iterable<string>): Promise<void> {
    const wanted = new Set<Source>();
    for (const p of paths) for (const s of sourcesOf(p)) wanted.add(s);
    for (const s of wanted) if (!this.loaded.has(s)) this.loaded.set(s, await this.load(s));
  }

  /** Whether a condition group passes, with the records it names read first. */
  async passes(group: AnyConditionGroup, now: number): Promise<boolean> {
    if (!group.conditions.length) return true;
    await this.need(conditionFields(group));
    return evaluate(group, (f) => this.fact(f), { now, timeZone: this.opts.timeZone });
  }

  async person(): Promise<PersonRecord | null> {
    await this.need(['person.id']);
    return this.get<PersonRecord>('person');
  }

  async lead(): Promise<LeadRecord | null> {
    await this.need(['lead.id']);
    return this.get<LeadRecord>('lead');
  }

  async appointment(): Promise<AppointmentRecord | null> {
    await this.need(['appointment.id']);
    return this.get<AppointmentRecord>('appointment');
  }

  async conversation(): Promise<ConversationRecord | null> {
    await this.need(['conversation.id']);
    return this.get<ConversationRecord>('conversation');
  }

  private get<T>(s: Source): T | null {
    return (this.loaded.get(s) as T | null | undefined) ?? null;
  }

  private assumed(path: string): { found: boolean; value: unknown } {
    const assume = this.opts.context['assume'];
    if (isRecord(assume) && Object.prototype.hasOwnProperty.call(assume, path))
      return { found: true, value: assume[path] };
    return { found: false, value: undefined };
  }

  /** A value in the run's context: `trigger.channel`, or deeper (`trigger.body.message`, a webhook's). */
  private ctx(group: string, key: string): unknown {
    let at: unknown = this.opts.context[group];
    for (const part of key.split('.')) {
      if (!isRecord(at)) return undefined;
      at = at[part];
    }
    return at;
  }

  /** A template variable's value (undefined when there is none). */
  value(path: string): unknown {
    const a = this.assumed(path);
    if (a.found) return a.value;
    const dot = path.indexOf('.');
    const head = dot < 0 ? path : path.slice(0, dot);
    const key = dot < 0 ? '' : path.slice(dot + 1);
    const p = this.get<PersonRecord>('person');
    const l = this.get<LeadRecord>('lead');
    const ap = this.get<AppointmentRecord>('appointment');
    const c = this.get<ConversationRecord>('conversation');
    const b = this.get<Business>('business');
    switch (head) {
      case 'person':
        if (!p) return undefined;
        if (key === 'name') return `${p.first_name} ${p.last_name}`.trim() || undefined;
        if (key === 'phone') return p.phone_e164 ? formatPhone(p.phone_e164) : undefined;
        return (p as unknown as Record<string, unknown>)[key] ?? undefined;
      case 'lead':
        if (!l) return undefined;
        if (key === 'value') return money(l.value_cents);
        return (l as unknown as Record<string, unknown>)[key] ?? undefined;
      case 'appointment':
        if (!ap) return undefined;
        if (key === 'starts_at') return ap.starts_at.toISOString();
        if (key === 'ends_at') return ap.ends_at.toISOString();
        if (key === 'location') return ap.location?.address || ap.location?.meetingUrl || undefined;
        return (ap as unknown as Record<string, unknown>)[key] ?? undefined;
      case 'conversation':
        if (!c) return undefined;
        if (key === 'channel') return c.channel === 'sms' ? 'text' : 'email';
        return key === 'last_message' ? (c.last_message ?? undefined) : undefined;
      case 'business':
        return b ? ((b as unknown as Record<string, unknown>)[key] ?? undefined) : undefined;
      case 'links':
        if (key === 'review') return b?.review ?? undefined;
        return key === 'booking' ? (this.get<string>('links') ?? undefined) : undefined;
      case 'workflow':
        return key === 'name' ? this.opts.workflowName : undefined;
      case 'ai':
      case 'trigger':
      case 'wait':
        return this.ctx(head, key);
      default:
        return undefined;
    }
  }

  /** A condition field's raw value. */
  fact(field: string): unknown {
    const a = this.assumed(field);
    if (a.found) return a.value;
    const dot = field.indexOf('.');
    const head = field.slice(0, dot);
    const key = field.slice(dot + 1);
    if (field === 'person.tags') return this.get<string[]>('person_tags') ?? [];
    if (field === 'lead.tags') return this.get<string[]>('lead_tags') ?? [];
    if (field === 'wait.timed_out') return this.ctx('wait', 'timed_out') === true;
    const p = this.get<PersonRecord>('person');
    const l = this.get<LeadRecord>('lead');
    const ap = this.get<AppointmentRecord>('appointment');
    const c = this.get<ConversationRecord>('conversation');
    switch (head) {
      case 'person':
        if (!p) return undefined;
        return key === 'phone'
          ? p.phone_e164
          : ((p as unknown as Record<string, unknown>)[key] ?? undefined);
      case 'lead':
        if (!l) return undefined;
        return key === 'value'
          ? l.value_cents / 100
          : ((l as unknown as Record<string, unknown>)[key] ?? undefined);
      case 'appointment':
        return ap ? ((ap as unknown as Record<string, unknown>)[key] ?? undefined) : undefined;
      case 'conversation':
        if (!c) return undefined;
        if (key === 'awaiting_reply') return c.awaiting_reply_since !== null;
        return (c as unknown as Record<string, unknown>)[key] ?? undefined;
      // `wait.button` too: the button the reply that ended the last wait came from (0101).
      case 'trigger':
      case 'ai':
      case 'wait':
        return this.ctx(head, key) ?? undefined;
      default:
        return undefined;
    }
  }

  /** The paths a template reads, for need(). */
  static templatePaths(...templates: readonly (string | null | undefined)[]): string[] {
    return templates.flatMap((t) => (t ? templateVars(t).map((v) => v.path) : []));
  }

  private async load(s: Source): Promise<unknown> {
    const { tx } = this;
    const ws = this.refs.workspaceId;
    switch (s) {
      case 'person': {
        if (!this.refs.personId) return null;
        const [p] = await rows<Record<string, unknown>>(
          tx,
          sql`select id, first_name, last_name, email::text as email, phone_e164, city, source, owner_user_id,
                sms_consent::text as sms_consent, created_at, archived_at
              from app.people where id = ${this.refs.personId} and workspace_id = ${ws}`,
        );
        return p ? { ...p, created_at: new Date(p['created_at'] as string) } : null;
      }
      case 'lead': {
        if (!this.refs.leadId) return null;
        const [l] = await rows<Record<string, unknown>>(
          tx,
          sql`select l.id, l.person_id, l.title, l.value_cents::float8 as value_cents, l.status::text as status,
                l.pipeline_id, l.stage_id, l.assignee_user_id, l.source, l.next_action, l.next_action_at,
                l.created_at, l.stage_entered_at, s.name as stage, p.name as pipeline,
                coalesce(nullif(u.full_name, ''), u.email::text) as assignee_name
              from app.leads l
              left join app.pipeline_stages s on s.id = l.stage_id
              left join app.pipelines p on p.id = l.pipeline_id
              left join app.users u on u.id = l.assignee_user_id
              where l.id = ${this.refs.leadId} and l.workspace_id = ${ws}`,
        );
        if (!l) return null;
        return {
          ...l,
          value_cents: Number(l['value_cents']),
          created_at: new Date(l['created_at'] as string),
          stage_entered_at: new Date(l['stage_entered_at'] as string),
          next_action_at: l['next_action_at'] ? new Date(l['next_action_at'] as string) : null,
        };
      }
      case 'appointment': {
        if (!this.refs.appointmentId) return null;
        const [a] = await rows<Record<string, unknown>>(
          tx,
          sql`select a.id, a.title, a.status::text as status, a.calendar_id, a.service_id, a.source::text as source,
                a.starts_at, a.ends_at, a.location, c.name as calendar, sv.name as service,
                (select string_agg(split_part(coalesce(nullif(u.full_name, ''), u.email::text), ' ', 1), ', '
                        order by (st.role::text = 'host') desc, st.created_at)
                   from app.appointment_staff st join app.users u on u.id = st.user_id
                   where st.appointment_id = a.id and st.active) as staff_names
              from app.appointments a
              left join app.calendars c on c.id = a.calendar_id
              left join app.services sv on sv.id = a.service_id
              where a.id = ${this.refs.appointmentId} and a.workspace_id = ${ws}`,
        );
        if (!a) return null;
        return {
          ...a,
          starts_at: new Date(a['starts_at'] as string),
          ends_at: new Date(a['ends_at'] as string),
        };
      }
      case 'conversation': {
        const pick = this.refs.conversationId
          ? sql`c.id = ${this.refs.conversationId}`
          : this.refs.personId
            ? sql`c.person_id = ${this.refs.personId}`
            : null;
        if (!pick) return null;
        const [c] = await rows<Record<string, unknown>>(
          tx,
          sql`select c.id, c.channel::text as channel, c.status::text as status, c.assignee_user_id,
                c.awaiting_reply_since,
                (select m.body_text from app.messages m
                   where m.conversation_id = c.id and m.direction = 'inbound'
                   order by m.occurred_at desc limit 1) as last_message
              from app.conversations c
              where c.workspace_id = ${ws} and ${pick}
              order by c.last_message_at desc nulls last limit 1`,
        );
        if (!c) return null;
        return {
          ...c,
          awaiting_reply_since: c['awaiting_reply_since']
            ? new Date(c['awaiting_reply_since'] as string)
            : null,
        };
      }
      case 'person_tags':
      case 'lead_tags': {
        const id = s === 'person_tags' ? this.refs.personId : this.refs.leadId;
        if (!id) return [];
        const list = await rows<{ tag_id: string }>(
          tx,
          sql`select tag_id from app.record_tags
              where workspace_id = ${ws} and record_type = ${s === 'person_tags' ? 'person' : 'lead'}
                and record_id = ${id}`,
        );
        return list.map((r) => r.tag_id);
      }
      case 'business': {
        const [w] = await rows<{ name: string; settings: unknown }>(
          tx,
          sql`select coalesce(nullif(bs.name, ''), w.name) as name, w.settings
              from app.workspaces w left join app.booking_sites bs on bs.workspace_id = w.id
              where w.id = ${ws}`,
        );
        const [n] = await rows<{ e164: string }>(
          tx,
          sql`select e164 from app.phone_numbers where workspace_id = ${ws} and status = 'active'
              order by created_at desc limit 1`,
        );
        const [e] = await rows<{ address: string }>(
          tx,
          sql`select address from app.email_addresses where workspace_id = ${ws}
              order by is_default desc, created_at limit 1`,
        );
        const settings = isRecord(w?.settings) ? w.settings : {};
        const links = isRecord(settings['links']) ? settings['links'] : {};
        const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
        return {
          name: w?.name ?? 'The business',
          phone: n ? formatPhone(n.e164) : null,
          email: e?.address ?? null,
          website: text(settings['website']),
          review: text(links['review']) ?? text(settings['reviewUrl']),
        } satisfies Business;
      }
      case 'links': {
        const cal = this.bookingCalendarId;
        const [c] = await rows<{ slug: string; site: string; enabled: boolean }>(
          tx,
          sql`select c.slug, bs.slug::text as site, bs.enabled
              from app.calendars c join app.booking_sites bs on bs.workspace_id = c.workspace_id
              where c.workspace_id = ${ws} and c.status = 'active' and c.public
                ${cal ? sql`and c.id = ${cal}` : sql``}
              order by c.created_at limit 1`,
        );
        if (!c?.enabled) return null;
        // Their own domain once one is serving (M17).
        const origin = await publicOrigin(tx, ws, this.opts.webUrl);
        return `${origin}/book/${c.site}/${c.slug}`;
      }
    }
  }
}
