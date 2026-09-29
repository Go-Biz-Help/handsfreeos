import type { Metadata } from 'next';
import { FoundingForm } from '@/components/founding-form';
import { FoundingCounter } from '@/components/founding-counter';
import { Check, Container, Section, SectionHeading } from '@/components/ui';
import { foundingContent, usageNote } from '@/content/site';
import { currentFoundingOffer, foundingCounts } from '@/lib/founding';

/**
 * Written to be true at every stage, because the page underneath it changes on its own: the free seats first,
 * then the $497 ones. A title that named the free offer would still be in a search result weeks after the last
 * free seat went.
 */
export const metadata: Metadata = {
  title: 'Founding seats for the first few businesses',
  description:
    'A limited number of businesses get HandsFreeOS free or for one payment, for as long as it exists. The count is live. Texts, calls and AI are billed for what you use.',
  alternates: { canonical: '/founding' },
};

/** Read every time somebody opens the page, cached for a minute. Never built into the page at deploy. */
export const revalidate = 60;

/**
 * Whichever founding offer is on sale now. The database moves the stage along by itself (0092) — the moment the
 * last free seat goes, this page is about the $497 seats — so nothing here names a stage. It reads the one the
 * counts say is current and renders that offer's own copy.
 *
 * When the worker cannot be reached there is no stage to read, and the page falls back to the first offer's
 * copy without a counter. That is rare — the fetch cache goes on serving the last answer it had while the
 * worker is away — and an application sent from it is still judged by the database: the free offer's queue if
 * a seat is open there, its waitlist if not. Nobody is told they have a seat they do not.
 */
export default async function FoundingPage() {
  const counts = await foundingCounts();
  const count = currentFoundingOffer(counts);
  const offer = foundingContent(count?.offerId);
  const open = count === null || count.status === 'open';
  const full = count !== null && count.remaining <= 0;

  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading sub={offer.sub} as="h1">
          {offer.headline}
        </SectionHeading>

        <div className="mt-10 max-w-md">
          <FoundingCounter count={count} />
        </div>
      </Container>

      <Container className="pb-16">
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 className="text-xl font-bold">What you get</h2>
            <ul className="mt-5 space-y-3 text-base">
              {offer.includes.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <Check className="text-success mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            {offer.asks.length > 0 ? (
              <>
                <h2 className="mt-10 text-xl font-bold">What we ask</h2>
                <ul className="mt-5 space-y-3 text-base">
                  {offer.asks.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <Check className="text-accent mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            {/*
              Said here, at the same size as everything else, rather than in a footnote. Somebody who discovers
              the usage bill afterwards was misled, however carefully the page was worded.
            */}
            <div className="border-border bg-card-2 mt-10 rounded-[var(--radius-card)] border p-5">
              <h3 className="text-base font-semibold">What is not included</h3>
              <p className="text-text-2 mt-2 text-base">{usageNote}</p>
              <p className="text-text-3 mt-3 text-sm">{offer.softwareLine}</p>
            </div>
          </div>

          <div>
            <h2 className="text-xl font-bold">
              {full ? 'Join the waitlist' : 'Ask for one of the seats'}
            </h2>
            <p className="text-text-2 mt-2">
              {open
                ? 'A few minutes, and a person reads it.'
                : 'We are not taking new applications at the moment, but the waitlist is open.'}
            </p>
            <div className="mt-6">
              <FoundingForm offerId={offer.id} full={full} />
            </div>
          </div>
        </div>
      </Container>

      <Section className="bg-card-2 border-border border-t">
        <SectionHeading sub={offer.afterwards}>If you miss it.</SectionHeading>
      </Section>
    </>
  );
}
