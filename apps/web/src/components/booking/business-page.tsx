/**
 * The business's simple page (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4, "A simple page"): the
 * booking page grown into a one-page site for a business with no website. What it does, with Book, Call, Text and
 * Chat; its services, the calendars customers book, its hours and where it works; and its privacy policy and terms.
 * All of it comes from what the business keeps (`PublicBusinessPage`), and a part it hasn't filled in is left out.
 * The setup's preview draws the same page from the answers, before it goes live.
 */
import { BUSINESS_PAGE_WORDS as W, businessPageHours } from '@hfos/core';
import {
  CalendarDays,
  ChevronRight,
  MapPin,
  MessageCircle,
  MessageSquare,
  Phone,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { buttonClassName } from '@/components/ui/button';
import type { PublicBusiness, PublicBusinessPage, PublicSite } from '@/lib/api/public-booking';
import { ChatButton } from './chat-button';

function Part({
  title,
  id,
  children,
  testId,
}: {
  title: string;
  id?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <section
      id={id}
      className="flex flex-col gap-3 rounded-[12px] border border-border bg-card p-4 md:p-5"
      data-testid={testId}
    >
      <h2 className="text-[15px] font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function BusinessPage({
  business,
  page,
  site,
  calendars,
}: {
  business: PublicBusiness;
  page: PublicBusinessPage;
  site: Pick<PublicSite['site'], 'slug' | 'enabled'>;
  /** The calendars customers can book; none while the booking page is off. */
  calendars: PublicSite['calendars'];
}) {
  const bookable = site.enabled ? calendars : [];
  const hours = page.openHours ? businessPageHours(page.openHours) : [];
  const button = (variant: 'primary' | 'secondary') =>
    buttonClassName({ variant, size: 'lg', className: 'max-sm:flex-1' });
  return (
    <div className="flex flex-col gap-5" data-testid="business-page">
      <section className="flex flex-col gap-2.5 pt-1">
        <h1 className="text-[24px] font-semibold leading-tight md:text-[28px]">{business.name}</h1>
        {page.place ? (
          <p className="flex items-center gap-1.5 text-[13.5px] text-text-2">
            <MapPin size={15} aria-hidden className="flex-none" />
            {page.place}
          </p>
        ) : null}
        {page.description ? (
          <p className="whitespace-pre-line text-[15px] leading-relaxed text-text-2">
            {page.description}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2" data-testid="business-page-actions">
          {bookable.length ? (
            <Link
              href={bookable.length === 1 ? `/book/${site.slug}/${bookable[0]!.slug}` : '#book'}
              className={button('primary')}
              data-testid="business-page-book"
            >
              <CalendarDays size={17} aria-hidden />
              {W.book}
            </Link>
          ) : null}
          {business.phone ? (
            <a
              href={`tel:${business.phone}`}
              className={button(bookable.length ? 'secondary' : 'primary')}
              data-testid="business-page-call"
            >
              <Phone size={17} aria-hidden />
              {W.call}
            </a>
          ) : null}
          {page.textTo ? (
            <a
              href={`sms:${page.textTo}`}
              className={button('secondary')}
              data-testid="business-page-text"
            >
              <MessageSquare size={17} aria-hidden />
              {W.text}
            </a>
          ) : null}
          {page.chat ? (
            <ChatButton className={button('secondary')}>
              <MessageCircle size={17} aria-hidden />
              {W.chat}
            </ChatButton>
          ) : null}
        </div>
      </section>

      {page.services.length ? (
        <Part title={page.servicesTitle} testId="business-page-services">
          <ul className="flex flex-col divide-y divide-border">
            {page.services.map((s) => (
              <li key={s.name} className="flex flex-col gap-0.5 py-2.5 first:pt-0 last:pb-0">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="text-[15px] font-medium">{s.name}</span>
                  {s.price ? (
                    <span className="flex-none text-[14px] text-text-2">{s.price}</span>
                  ) : null}
                </span>
                {s.description ? (
                  <span className="text-[13.5px] text-text-2">{s.description}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </Part>
      ) : null}

      {bookable.length > 1 ? (
        <Part title={W.book} id="book" testId="business-page-calendars">
          <ul className="flex flex-col gap-2">
            {bookable.map((c) => (
              <li key={c.slug}>
                <Link
                  href={`/book/${site.slug}/${c.slug}`}
                  className="flex min-h-[56px] items-center gap-3 rounded-[10px] border border-border-strong bg-card px-3.5 py-3 transition-colors hover:border-accent hover:bg-card-2"
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-px">
                    <span className="text-[15px] font-medium">{c.name}</span>
                    {c.description ? (
                      <span className="text-xs text-text-2">{c.description}</span>
                    ) : null}
                  </span>
                  <ChevronRight size={18} className="flex-none text-text-3" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        </Part>
      ) : null}

      {hours.length || page.hours.trim() ? (
        <Part title={W.hours} testId="business-page-hours">
          {hours.length ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[14px]">
              {hours.map((row) => (
                <div key={row.days} className="contents">
                  <dt className="text-text-2">{row.days}</dt>
                  <dd>{row.times}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="whitespace-pre-line text-[14px]">{page.hours}</p>
          )}
        </Part>
      ) : null}

      {page.area.trim() ? (
        <Part title={W.area} testId="business-page-area">
          <p className="whitespace-pre-line text-[14px]">{page.area}</p>
        </Part>
      ) : null}

      <nav
        className="flex items-center justify-center gap-3 text-[12.5px] text-text-3"
        aria-label={`${W.privacy} and ${W.terms}`}
      >
        <a href={page.privacyPath} className="hover:text-text-2 hover:underline">
          {W.privacy}
        </a>
        <span aria-hidden>·</span>
        <a href={page.termsPath} className="hover:text-text-2 hover:underline">
          {W.terms}
        </a>
      </nav>
    </div>
  );
}
