/**
 * What a calendar asks for before it will hold a time, read from the database: the price of what is being
 * booked, and the deposit that follows from it. Server-side, so the booking routes, the AI teammate's guard
 * and the teammate's own context all work it out the same way rather than three ways.
 */
import { rows, sql, type Tx } from '@hfos/db/client';
import type { CalendarConfig } from './config';
import { bookingCharge, type BookingCharge } from './deposit';
import { loadMoneySettings } from '../commands/money-shared';

export interface VisitPrice {
  readonly priceCents: number;
  /** What the line is called: the product's name where one prices the service, else the service's. */
  readonly name: string | null;
  /** The product's own taxability, when a product prices it; null to follow the business's default. */
  readonly taxable: boolean | null;
}

/**
 * What a visit costs, as the catalogue has it: the product a service is priced by if there is one (the money
 * side of the same thing), else the service's own "price shown". Zero when nobody has set a price — a
 * percentage of nothing is nothing, and `bookingCharge` then asks for nothing at all.
 */
export async function visitPrice(
  tx: Tx,
  workspaceId: string,
  serviceId: string | null,
): Promise<VisitPrice> {
  if (!serviceId) return { priceCents: 0, name: null, taxable: null };
  const [row] = await rows<{
    service_name: string;
    service_price: number | null;
    product_name: string | null;
    product_price: number | null;
    product_taxable: boolean | null;
  }>(
    tx,
    sql`select s.name as service_name, s.price_cents::float8 as service_price,
          p.name as product_name, p.unit_price_cents::float8 as product_price, p.taxable as product_taxable
        from app.services s
        left join app.products p
          on p.service_id = s.id and p.workspace_id = s.workspace_id and p.archived_at is null
        where s.id = ${serviceId} and s.workspace_id = ${workspaceId}
        limit 1`,
  );
  if (!row) return { priceCents: 0, name: null, taxable: null };
  const priced = row.product_price !== null && Number(row.product_price) > 0;
  return {
    priceCents: Math.max(
      0,
      Math.round(Number(priced ? row.product_price : row.service_price) || 0),
    ),
    name: (priced ? row.product_name : row.service_name) ?? row.service_name,
    taxable: priced ? row.product_taxable : null,
  };
}

/** The service a booking on this calendar actually lands on when the caller doesn't name one. */
export function bookedServiceId(config: CalendarConfig, serviceId?: string | null): string | null {
  if (serviceId) return serviceId;
  return config.services.mode === 'none' ? null : (config.services.items[0]?.serviceId ?? null);
}

/** What is due before this calendar will hold a time, with what the visit costs, or null for nothing. */
export async function calendarCharge(
  tx: Tx,
  workspaceId: string,
  config: CalendarConfig,
  serviceId?: string | null,
): Promise<{ charge: BookingCharge; price: VisitPrice } | null> {
  if (config.payments.mode === 'none') return null;
  const settings = await loadMoneySettings(tx, workspaceId);
  const price = await visitPrice(tx, workspaceId, bookedServiceId(config, serviceId));
  const charge = bookingCharge(config, settings.deposit, price.priceCents);
  return charge ? { charge, price } : null;
}

/** The most this calendar would ask for across everything it books: what its list of services says. */
export async function calendarMostCharged(
  tx: Tx,
  workspaceId: string,
  config: CalendarConfig,
): Promise<BookingCharge | null> {
  if (config.payments.mode === 'none') return null;
  const ids = config.services.items.map((i) => i.serviceId);
  const settings = await loadMoneySettings(tx, workspaceId);
  let best: BookingCharge | null = null;
  for (const id of ids.length ? ids : [null]) {
    const price = await visitPrice(tx, workspaceId, id);
    const charge = bookingCharge(config, settings.deposit, price.priceCents);
    if (charge && (!best || charge.amountCents > best.amountCents)) best = charge;
  }
  return best;
}
