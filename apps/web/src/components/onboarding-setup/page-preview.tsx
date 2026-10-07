'use client';
/**
 * "A simple page for your business" (HANDSFREEOS_ONBOARDING_QUICK_SETUP_IMPLEMENTATION_PLAN.md §4): the page drawn
 * from the answers so far, as customers will see it, before it goes live. It's the public page's own parts
 * (components/booking), shown with every button it will have once the business number, the booking page and the
 * AI teammate's chat are set up, and nothing in it can be pressed.
 */
import {
  BUSINESS_PAGE_WORDS,
  onboardingPagePreview,
  setupFor,
  ONBOARDING_SETUP_WORDS as W,
  type OnboardingSetupAnswers,
  type OnboardingSetupState,
} from '@hfos/core';
import { BusinessPage } from '@/components/booking/business-page';
import { Byline, PublicHeader } from '@/components/booking/public-shell';
import type { PublicBusiness } from '@/lib/api/public-booking';
import { brandLook, logoSrc } from '@/lib/look';
import { cn } from '@/lib/utils';

/** Stands in for the number, the booking calendar and the chat the page will have. */
const SOON = 'soon';

export function PagePreview({
  state,
  answers,
}: {
  state: OnboardingSetupState;
  answers: OnboardingSetupAnswers;
}) {
  const color = state.look.color?.hex ?? null;
  const look = brandLook(color);
  const logo = state.look.logo
    ? {
        url: logoSrc(state.look.logo.path),
        width: state.look.logo.width,
        height: state.look.logo.height,
      }
    : null;
  const business: PublicBusiness = {
    name: state.businessName,
    phone: SOON,
    phoneDisplay: state.numberSetup.display,
    look: { logo, color },
  };
  const page = { ...onboardingPagePreview(state, answers), textTo: SOON, chat: SOON };
  const calendar = state.calendars[0]?.name ?? setupFor(state.industry).calendar;
  return (
    <figure className="flex flex-col gap-2" data-testid="setup-page-preview">
      <div
        className="max-h-[480px] overflow-y-auto rounded-menu border border-border-strong shadow-1"
        role="img"
        aria-label={W.pagePreview}
      >
        <div inert className={cn('bg-bg text-text', look.className)} style={look.style}>
          <PublicHeader business={business} />
          <div className="px-4 py-5">
            <BusinessPage
              business={business}
              page={page}
              site={{ slug: SOON, enabled: answers.booksTime }}
              calendars={[{ slug: SOON, name: calendar, description: null }]}
            />
          </div>
          <div className="pb-4">
            <Byline words={BUSINESS_PAGE_WORDS.byline} />
          </div>
        </div>
      </div>
      <figcaption className="text-[12.5px] text-text-3">
        {W.pageButtonsLater(answers.booksTime)}
      </figcaption>
    </figure>
  );
}
