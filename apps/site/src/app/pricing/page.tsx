import type { Metadata } from 'next';
import { IconBadge, Icons } from '@/components/icons';
import { FoundingCounter } from '@/components/founding-counter';
import { FaqJsonLd } from '@/components/json-ld';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { pricingFaqs } from '@/content/faqs';
import { annualNote, foundingContent, plan, urls, usageNote } from '@/content/site';
import { currentFoundingOffer, foundingCounts, monthlyOnSale } from '@/lib/founding';

/**
 * True at every stage. What is on sale changes by itself — free seats, then $497 seats, then the monthly plan
 * beside them — and a search result keeps a page's title for weeks after the page has moved on.
 */
export const metadata: Metadata = {
  title: 'Pricing — founding seats, then one plan with everything in it',
  description: `Founding seats while they last, then one plan at $${plan.price} a month: every feature, one business, unlimited people and customers. Texts, calls and AI are billed for what you use.`,
  alternates: { canonical: '/pricing' },
};

/** The seat counts are live, so the page is rebuilt at most once a minute rather than at deploy. */
export const revalidate = 60;

/**
 * Two things decide the page, and both come from the database (0092): which founding offer is current, and
 * whether the monthly plan has gone on sale beside it. Neither is decided here — the page renders the stage it
 * is told, so it can never show a stage the database has left or one it has not reached.
 */
export default async function PricingPage() {
  const counts = await foundingCounts();
  const count = currentFoundingOffer(counts);
  const offer = count ? foundingContent(count.offerId) : null;
  const monthly = monthlyOnSale(counts);
  const full = count !== null && count.remaining <= 0;

  return (
    <>
      <FaqJsonLd faqs={pricingFaqs} id={`${urls.site}/pricing#faq`} />

      <Container className="py-16 sm:py-20">
        {monthly ? (
          <SectionHeading
            sub="Every feature, one business, as many people as work there. Texts, calls and AI are billed for what you use, so a quiet month costs less than a busy one."
            as="h1"
          >
            One price a month. No setup fee.
          </SectionHeading>
        ) : (
          <SectionHeading
            sub="Before HandsFreeOS goes on sale month to month, a limited number of businesses get it for nothing or for one payment, for as long as it exists. The count below is live."
            as="h1"
          >
            Founding seats are open.
          </SectionHeading>
        )}
      </Container>

      {/*
        The founding offer on sale now, and only that one. An earlier offer a later one has superseded is not
        shown beside it: a free seat that frees up after the $497 seats open goes to the waitlist from /admin,
        not back on the page next to a paid one.
      */}
      {count && offer ? (
        <Container className="pb-10">
          <div className="mx-auto max-w-xl">
            <Card className="flex h-full flex-col">
              <h2 className="text-xl font-bold">{offer.name}</h2>
              <p className="text-text-2 mt-2">{offer.blurb}</p>
              <p className="mt-6 text-4xl font-bold">{offer.priceLabel}</p>

              <FoundingCounter count={count} className="mt-6" />

              <Button
                href="/founding"
                className="mt-6 w-full"
                size="lg"
                variant={full ? 'secondary' : 'primary'}
              >
                {full ? 'Join the waitlist' : 'Apply for a seat'}
              </Button>

              <ul className="mt-7 space-y-3 text-base">
                {offer.includes.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="text-success mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="text-text-3 mt-6 text-sm">{offer.softwareLine}</p>
            </Card>
          </div>
        </Container>
      ) : null}

      {/*
        The plan goes on sale by itself partway through the $497 seats. Until then it is not on the page at all:
        the founding seats are the offer, and a monthly price beside a pay-once one makes the monthly one the
        yardstick. If the worker cannot be reached, it shows — see monthlyOnSale.
      */}
      {monthly ? (
        <Container className="pb-8">
          <div className="mx-auto grid max-w-xl gap-6">
            <Card className="border-accent ring-accent/25 flex flex-col ring-2">
              <IconBadge>
                <Icons.bolt />
              </IconBadge>
              <h2 className="text-xl font-bold">{plan.name}</h2>
              <p className="text-text-2 mt-2">{plan.blurb}</p>
              <p className="mt-6 text-5xl font-bold">
                ${plan.price}
                <span className="text-text-3 text-base font-normal"> /month</span>
              </p>
              <p className="text-text-3 mt-2 text-sm">{plan.seats}</p>

              <Button href={urls.signUp} className="mt-6 w-full" size="lg">
                Start free
              </Button>

              <ul className="mt-7 space-y-3 text-base">
                {plan.includes.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="text-success mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </div>
        </Container>
      ) : null}

      <Container className="py-14">
        <div
          className={`border-border bg-card-2 grid gap-6 rounded-[var(--radius-card)] border p-6 ${
            monthly ? 'sm:grid-cols-2' : ''
          }`}
        >
          <div>
            <h3 className="font-semibold">Texts, calls and AI</h3>
            <p className="text-text-2 mt-2 text-base">{usageNote}</p>
          </div>
          {monthly ? (
            <div>
              <h3 className="font-semibold">Paying yearly</h3>
              <p className="text-text-2 mt-2 text-base">{annualNote}</p>
            </div>
          ) : null}
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
            <Button href={urls.signUp} size="lg">
              Start free
            </Button>
            <Button href="/support" size="lg" variant="secondary">
              Ask us
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
