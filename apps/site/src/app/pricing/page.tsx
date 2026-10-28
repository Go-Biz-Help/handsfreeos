import type { Metadata } from 'next';
import { FoundingCounter } from '@/components/founding-counter';
import { FaqJsonLd } from '@/components/json-ld';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { pricingFaqs } from '@/content/faqs';
import {
  moneyBack,
  noSpotsNote,
  plan,
  signUpFor,
  spotPrices,
  urls,
  usageNote,
} from '@/content/site';
import { foundingCounts, foundingSpotsOnSale, hasRoom } from '@/lib/founding';

/**
 * The prices are the two founding spots'. A search result keeps a page's title for weeks, so it names the prices,
 * which change only when the owner changes them, and never a count.
 */
export const metadata: Metadata = {
  title: `Pricing: ${spotPrices}`,
  description: `Founding spots, first come, first served: ${spotPrices}. Every feature, one business, unlimited people. Texts, calls and AI are billed as used.`,
  alternates: { canonical: '/pricing' },
};

/** The spot counts are live, so the page is rebuilt at most once a minute rather than at deploy. */
export const revalidate = 60;

/**
 * Founding spots, first come, first served (20261027012700): sign up, pick one and pay. Which spots are on sale, and
 * how many of each are left, come from the database — the page renders what it is told, so it never shows a spot
 * the database has stopped selling, or room it doesn't have.
 */
export default async function PricingPage() {
  const spots = foundingSpotsOnSale(await foundingCounts());
  const open = spots.filter(hasRoom);

  return (
    <>
      <FaqJsonLd faqs={pricingFaqs} id={`${urls.site}/pricing#faq`} />

      <Container className="py-16 sm:py-20">
        {open.length > 0 ? (
          <SectionHeading
            sub={`Sign up, pick your spot and pay, first come, first served. Every feature, one business, as many people as work there: most CRMs charge for every person who logs in, and this one does not. And if it isn’t for you within ${moneyBack.days} days, you get your money back. The counts below are live.`}
            as="h1"
          >
            Founding spots are open.
          </SectionHeading>
        ) : (
          <SectionHeading sub={noSpotsNote} as="h1">
            Founding spots are closed for now.
          </SectionHeading>
        )}
      </Container>

      <Container className="pb-10">
        <div
          className={`mx-auto grid gap-6 ${spots.length > 1 ? 'max-w-4xl md:grid-cols-2' : 'max-w-xl'}`}
        >
          {spots.map((spot) => {
            const { content, count } = spot;
            const room = hasRoom(spot);
            return (
              <Card
                key={content.id}
                className={`flex h-full flex-col ${
                  room && content.plan === 'yearly' ? 'border-accent ring-accent/25 ring-2' : ''
                }`}
              >
                <h2 className="text-xl font-bold">{content.name}</h2>
                <p className="text-text-2 mt-2">{content.blurb}</p>
                <p className="mt-6 text-5xl font-bold">
                  {content.priceLabel}
                  <span className="text-text-3 text-base font-normal"> {content.per}</span>
                </p>

                <FoundingCounter count={count} className="mt-6" />

                {room ? (
                  <Button href={signUpFor(content)} className="mt-6 w-full" size="lg">
                    Claim my {content.priceLabel} spot
                  </Button>
                ) : (
                  <p className="text-text-3 mt-6 text-sm">
                    {open.length > 0
                      ? 'All taken. The other spot still has room.'
                      : 'All taken for now.'}
                  </p>
                )}

                <ul className="mt-7 space-y-3 text-base">
                  {content.includes.map((item) => (
                    <li key={item} className="flex gap-2.5">
                      <Check className="text-success mt-0.5" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            );
          })}
        </div>
      </Container>

      <Container className="py-14">
        <div className="border-border bg-card grid gap-8 rounded-[var(--radius-card)] border p-6 sm:p-8 lg:grid-cols-[1fr_1.4fr]">
          <div>
            <h2 className="text-2xl font-bold">Every spot buys all of it.</h2>
            <p className="text-text-2 mt-3 text-base">
              {plan.blurb} {plan.seats}
            </p>
          </div>
          <ul className="grid gap-3 text-base sm:grid-cols-2">
            {plan.includes.map((item) => (
              <li key={item} className="flex gap-2.5">
                <Check className="text-success mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-6 grid gap-6 md:grid-cols-2">
          <div className="border-border bg-card-2 rounded-[var(--radius-card)] border p-6">
            <h3 className="font-semibold">Texts, calls and AI</h3>
            <p className="text-text-2 mt-2 text-base">{usageNote}</p>
          </div>
          {/* The owner's money-back promise (2026-10-28), in the same words as the home page and the terms. */}
          <div className="border-border bg-card-2 rounded-[var(--radius-card)] border p-6">
            <h3 className="font-semibold">{moneyBack.days} days, or your money back</h3>
            <p className="text-text-2 mt-2 text-base">{moneyBack.line}</p>
          </div>
        </div>
      </Container>

      <Section className="bg-card-2 border-border border-y">
        <SectionHeading>What people ask about the price</SectionHeading>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          {pricingFaqs.map((item) => (
            <div key={item.q}>
              <h3 className="text-lg font-semibold">{item.q}</h3>
              <p className="text-text-2 mt-2.5">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold">Not sure it fits?</h2>
          <p className="text-text-2 mt-4 text-lg">
            Tell us how many of you there are and how the leads come in, and we will tell you
            straight — including if the answer is that you do not need this yet.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            {open.length > 0 ? (
              <Button href={urls.signUp} size="lg">
                Sign up
              </Button>
            ) : null}
            <Button href="/support" size="lg" variant="secondary">
              Ask us
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
