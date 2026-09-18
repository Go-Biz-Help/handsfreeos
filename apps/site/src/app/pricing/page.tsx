import type { Metadata } from 'next';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { annualNote, plans, urls, usageNote } from '@/content/site';

export const metadata: Metadata = {
  title: 'Pricing',
  description:
    'What HandsFreeOS costs: one price a month for everything in the plan, with texts, calls and AI passed through at cost.',
};

export default function PricingPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading sub="Every plan has your own business number, the inbox, your customers, the calendar, and quotes and invoices you get paid on. Growth then has everything else HandsFreeOS does — nothing is held back for a bigger plan. Pro is for running more than one business.">
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
                <span className="bg-accent text-on-solid mb-4 -mt-1 w-fit rounded-full px-3 py-1 text-xs font-semibold">
                  Where most businesses start
                </span>
              ) : null}
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
          {[
            {
              q: 'What does "start free" mean?',
              a: 'You can make an account, bring your customers in and look around without paying. You start a plan when you want a business number and the AI answering for you — that is the point where it costs us real money on your behalf.',
            },
            {
              q: 'Is there a contract?',
              a: 'No. Month to month, cancel whenever. Your customers, conversations and files export on your way out.',
            },
            {
              q: 'Do you take a cut of what I get paid?',
              a: 'No. Your customers pay into your own Stripe or Square account and you pay those companies their normal card fee. HandsFreeOS never touches the money.',
            },
            {
              q: 'Why is there usage on top?',
              a: 'Because the phone companies charge per text and per minute, and the AI charges per reply. We pass those through rather than pad the plan for the businesses that barely use them.',
            },
            {
              q: 'Does Growth hold anything back for Pro?',
              a: 'No. Growth is every feature HandsFreeOS has, for one business. The only thing Pro adds is running more than one business or location, and the help that comes with that.',
            },
            {
              q: 'What happens when there are more than 8 of us?',
              a: 'Growth covers eight people, then it is $15 a month for each person after that. Pro has no per-person charge at all, which is usually the cheaper answer once a team gets big.',
            },
            {
              q: 'What if I have two locations?',
              a: 'That is Pro: several businesses under one login, each with its own number, calendar and books, one place you can see them all from, and your templates and knowledge shared across them.',
            },
            {
              q: 'Can you move me off the CRM I use now?',
              a: 'Yes, and it is included in every plan, not a paid extra. On Starter and Growth you run it yourself — it counts everything before it moves anything, and it can be undone. On Pro we do it with you.',
            },
            {
              q: 'Is support better on the expensive plan?',
              a: 'Everyone gets the same email support from the people who build it. Pro jumps the queue and gets someone who sets the whole thing up with you, because several locations is more to set up.',
            },
            {
              q: 'Can I change plans later?',
              a: 'Any time, in both directions. Going down never deletes anything — features just stop being available.',
            },
          ].map((item) => (
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
