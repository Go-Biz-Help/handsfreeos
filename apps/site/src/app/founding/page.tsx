import type { Metadata } from 'next';
import { FoundingForm } from '@/components/founding-form';
import { FoundingCounter } from '@/components/founding-counter';
import { Check, Container, Section, SectionHeading } from '@/components/ui';
import { foundingOffers, plan, usageNote } from '@/content/site';
import { foundingCounts } from '@/lib/founding';

export const metadata: Metadata = {
  title: 'Founding partners — 25 businesses, free for life',
  description:
    'Twenty-five businesses get HandsFreeOS free for as long as it exists, in exchange for telling us the truth about what is missing. Texts, calls and AI are billed for what you use.',
  alternates: { canonical: '/founding' },
};

/** Read every time somebody opens the page, cached for a minute. Never built into the page at deploy. */
export const revalidate = 60;

export default async function FoundingPage() {
  const counts = await foundingCounts();
  const partner = foundingOffers[0];
  const count = counts?.find((c) => c.offerId === partner.id) ?? null;
  const open = count === null || count.status === 'open';
  const full = count !== null && count.remaining <= 0;

  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="Not a beta, and not a discount. Twenty-five real businesses using it for real work, telling us what is wrong, for as long as HandsFreeOS exists."
          as="h1"
        >
          Twenty-five founding partners.
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
              {partner.includes.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <Check className="text-success mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            <h2 className="mt-10 text-xl font-bold">What we ask</h2>
            <ul className="mt-5 space-y-3 text-base">
              {partner.asks.map((item) => (
                <li key={item} className="flex gap-2.5">
                  <Check className="text-accent mt-0.5" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>

            {/*
              Said here, at the same size as everything else, rather than in a footnote. A founding partner
              who discovers the usage bill afterwards was misled, however carefully the page was worded.
            */}
            <div className="border-border bg-card-2 mt-10 rounded-[var(--radius-card)] border p-5">
              <h3 className="text-base font-semibold">What is not free</h3>
              <p className="text-text-2 mt-2 text-base">{usageNote}</p>
              <p className="text-text-3 mt-3 text-sm">
                The software is free for life. The phone company is not.
              </p>
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
              <FoundingForm offerId={partner.id} full={full} />
            </div>
          </div>
        </div>
      </Container>

      <Section className="bg-card-2 border-border border-t">
        <SectionHeading
          sub={`When the twenty-five are gone, HandsFreeOS is $${plan.price} a month, or ${foundingOffers[1].priceLabel} for life while those last.`}
        >
          If you miss it.
        </SectionHeading>
      </Section>
    </>
  );
}
