import type { Metadata } from 'next';
import { IconBadge, Icons } from '@/components/icons';
import { FaqJsonLd } from '@/components/json-ld';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { pricingFaqs } from '@/content/faqs';
import {
  annualNote,
  highestPrice,
  lowestPrice,
  planComparison,
  plans,
  urls,
  usageNote,
} from '@/content/site';

export const metadata: Metadata = {
  title: `Pricing — $${lowestPrice} to $${highestPrice} a month`,
  description:
    'Three plans for small service businesses, month to month, no setup fee. Growth is every feature for one business; texts, calls and AI are billed for what you use.',
  alternates: { canonical: '/pricing' },
};

export default function PricingPage() {
  return (
    <>
      <FaqJsonLd faqs={pricingFaqs} id={`${urls.site}/pricing#faq`} />
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="Every plan has your own business number, the inbox, your customers, the calendar, and quotes and invoices you get paid on. Growth then has everything else HandsFreeOS does — nothing is held back for a bigger plan. Pro is for running more than one business."
          as="h1"
        >
          One price a month. No setup fee.
        </SectionHeading>
      </Container>

      <Container className="pb-8">
        <div className="grid gap-6 lg:grid-cols-3">
          {plans.map((plan) => (
            <Card
              key={plan.id}
              className={[
                'flex h-full flex-col',
                plan.featured ? 'border-accent ring-accent/25 ring-2' : '',
              ].join(' ')}
            >
              {plan.featured ? (
                <span className="bg-accent text-white mb-4 -mt-1 w-fit rounded-full px-3 py-1 text-xs font-semibold">
                  Where most businesses start
                </span>
              ) : null}
              <IconBadge>
                <PlanIcon id={plan.id} />
              </IconBadge>
              <h2 className="text-xl font-bold">{plan.name}</h2>
              <p className="text-text-2 mt-2">{plan.blurb}</p>
              <p className="mt-6 text-4xl font-bold">
                ${plan.price}
                <span className="text-text-3 text-base font-normal"> /month</span>
              </p>
              <p className="text-text-3 mt-2 text-sm">{plan.seats}</p>

              <Button
                href={urls.signUp}
                className="mt-6 w-full"
                size="lg"
                variant={plan.featured ? 'primary' : 'secondary'}
              >
                Start free
              </Button>

              <ul className="mt-7 space-y-3 text-base">
                {plan.includes.map((item) => (
                  <li key={item} className="flex gap-2.5">
                    <Check className="text-success mt-0.5" />
                    <span>{item}</span>
                  </li>
                ))}
                {plan.missing.map((item) => (
                  <li key={item} className="text-text-3 flex gap-2.5">
                    <svg
                      viewBox="0 0 20 20"
                      aria-hidden="true"
                      className="mt-0.5 h-5 w-5 shrink-0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                    >
                      <path d="M5 10h10" />
                    </svg>
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>

        {/* On a phone the three cards above already answer this, and a four-column table would
            either scroll out of sight or squeeze to nothing. It appears once there is room. */}
        <div className="border-border mt-14 hidden overflow-x-auto rounded-[var(--radius-card)] border sm:block">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <caption className="sr-only">What changes between the plans</caption>
            <thead>
              <tr className="border-border bg-card-2 border-b">
                <th
                  scope="col"
                  className="text-text-3 px-4 py-3 text-xs font-semibold tracking-[0.1em] uppercase"
                >
                  What changes
                </th>
                {plans.map((plan) => (
                  <th
                    key={plan.id}
                    scope="col"
                    className={`px-4 py-3 text-center text-sm font-bold ${
                      plan.featured ? 'text-accent-text' : ''
                    }`}
                  >
                    {plan.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {planComparison.map((row) => (
                <tr key={row.what} className="border-border border-b last:border-b-0">
                  <th scope="row" className="text-text-2 px-4 py-3 text-left text-base font-normal">
                    {row.what}
                  </th>
                  {([row.starter, row.growth, row.pro] as const).map((value, index) => (
                    <td
                      key={index}
                      className={`px-4 py-3 text-center text-sm ${
                        index === 1 ? 'bg-accent-soft/40' : ''
                      }`}
                    >
                      <Answer value={value} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-border bg-card-2 mt-8 grid gap-6 rounded-[var(--radius-card)] border p-6 sm:grid-cols-2">
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

      <Section className="bg-card-2 border-border mt-8 border-y">
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
          <h2 className="text-3xl font-bold">Still not sure which one?</h2>
          <p className="text-text-2 mt-4 text-lg">
            Tell us how many of you there are and how the leads come in, and we will tell you which
            plan fits — including if that is the cheapest one.
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

/** A tick, a dash, or the words for that plan. */
function Answer({ value }: { value: boolean | string }) {
  if (value === true) {
    return (
      <>
        <Check className="text-success mx-auto" />
        <span className="sr-only">Included</span>
      </>
    );
  }
  if (value === false) {
    return (
      <>
        <span aria-hidden="true" className="text-text-3">
          —
        </span>
        <span className="sr-only">Not included</span>
      </>
    );
  }
  return <span className="text-text-2">{value}</span>;
}

function PlanIcon({ id }: { id: string }) {
  if (id === 'growth') return <Icons.bolt />;
  if (id === 'pro') return <Icons.apps />;
  return <Icons.phone />;
}
