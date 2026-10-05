/** The day to chase someone outside a deal is waiting on (round four, step 4). */
import { localInstant } from '../../../calendar/engine/zoned';
import { addBusinessDays } from '../dates/business-days';
import { businessCalendarOf, timeZoneOf, todayIn, type Ctx } from './common';

/** The day to chase someone outside: two business days on, at 9:00 where the business is. */
export async function chaseDefault(ctx: Ctx, from: Date): Promise<Date> {
  const timeZone = await timeZoneOf(ctx);
  const calendar = await businessCalendarOf(ctx);
  return chaseOn(addBusinessDays(todayIn(timeZone, from), 2, calendar).date, timeZone);
}

/** A day to chase, as the moment it comes: 9:00 that morning where the business is. */
export const chaseOn = (date: string, timeZone: string): Date =>
  new Date(localInstant(date, '09:00', timeZone));
