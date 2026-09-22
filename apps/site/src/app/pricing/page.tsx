import type { Metadata } from 'next';
import { IconBadge, Icons } from '@/components/icons';
import { FoundingCounter } from '@/components/founding-counter';
import { FaqJsonLd } from '@/components/json-ld';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { pricingFaqs } from '@/content/faqs';
import { annualNote, foundingOffers, plan, urls, usageNote } from '@/content/site';
import { foundingCounts } from '@/lib/founding';

export const metadata: Metadata = {
  title: `Pricing — $${plan.price} a month, everything included`,
  description: `One plan at $${plan.price} a month: every feature, one business, unlimited people and customers. Texts, calls and AI are billed for what you use. Founding seats are open while they last.`,
  alternates: { canonical: '/pricing' },
};

/** The seat counts are live, so the page is rebuilt at most once a minute rather than at deploy. */
export const revalidate = 60;

export default async function PricingPage() {
  const counts = await foundingCounts();
  const open = foundingOffers
    .map((offer) => ({ offer, count: counts?.find((c) => c.offerId === offer.id) ?? null }))
    .filter(({ count }) => count !== null && count.status !== 'draft');

  return (
    <>
      <FaqJsonLd faqs={pricingFaqs} id={`${urls.site}/pricing#faq`} />

      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub={`Every feature, one business, as many people as work there. Texts, calls and AI are billed for what you use, so a quiet month costs less than a busy one.`}
          as="h1"
        >
          One price a month. No setup fee.
        </SectionHeading>
      </Container>

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

      {/*
        The founding offers only appear once the database says they exist. A draft offer, a worker that is
        down, or a counter switched off all mean nothing renders here — better an absent section than one
        advertising seats that are not really on sale.
      */}
      {open.length > 0 ? (
        <Section className="bg-card-2 border-border border-y">
          <SectionHeading sub="A limited number of businesses pay once, or nothing at all, and keep HandsFreeOS for as long as it exists. The counts below are live.">
            While they last.
          </SectionHeading>

          <div className="mt-10 grid gap-6 md:grid-cols-2">
            {open.map(({ offer, count }) => {
              const full = count !== null && count.remaining <= 0;
              return (
                <Card key={offer.id} className="flex h-full flex-col">
                  <h3 className="text-xl font-bold">{offer.name}</h3>
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
                </Card>
              );
            })}
          </div>

          <p className="text-text-3 mt-8 text-sm">
            Usage is billed the same way on every offer here, the free one included. The software is
            free for life; the phone company is not.
          </p>
        </Section>
      ) : null}

      <Container className="py-14">
        <div className="border-border bg-card-2 grid gap-6 rounded-[var(--radius-card)] border p-6 sm:grid-cols-2">
          <div>
            <h3 className="font-semibold">Texts, calls and AI</h3>
            <p className="text-text-2 mt-2 text-base">{usageNote}</p>
          </div>
          <div>
            <h3 className="font-semibold">Paying yearly</h3>
            <p className="text-text-2 mt-2 text-base">{annualNote}</p>
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
