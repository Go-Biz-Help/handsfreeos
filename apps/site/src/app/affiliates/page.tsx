import type { Metadata } from 'next';
import { FaqJsonLd } from '@/components/json-ld';
import { Button, Card, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import { affiliateFaqs, affiliateRules, applyUrl, exampleEarnings } from '@/content/affiliates';
import { urls } from '@/content/site';
import { affiliateProgram, percentWords } from '@/lib/affiliate-program';

/**
 * The search result says what the program is without a number: staff can change the share, and a result keeps a
 * page's description for weeks.
 */
export const metadata: Metadata = {
  title: 'Affiliates: sell HandsFreeOS and earn',
  description: `Earn a share of every plan payment from each business you send to HandsFreeOS, for its first ${affiliateRules.months} months. Paid monthly to your bank.`,
  alternates: { canonical: '/affiliates' },
};

/** The share is read live, so the page is rebuilt at most every five minutes rather than at deploy. */
export const revalidate = 300;

/**
 * People who sell HandsFreeOS for a share (HANDSFREEOS_AFFILIATES_IMPLEMENTATION_PLAN.md part 5): what they earn,
 * how it works, and Apply, which goes to their affiliate page in the app. Without the live share, the page says "a
 * share" and leaves the examples out.
 */
export default async function AffiliatesPage() {
  const program = await affiliateProgram();
  const share = program ? percentWords(program.rateBp) : 'a share';
  const maxOff = program ? percentWords(program.maxDiscountBp) : 'half';
  const faqs = affiliateFaqs(share, maxOff);
  const examples = program ? exampleEarnings(program.rateBp) : [];

  const steps = [
    {
      title: 'Apply',
      body: 'Sign in, or make a free HandsFreeOS sign-in, and tell us how you’ll share it. You don’t need to be a customer. We read every application.',
    },
    {
      title: 'Share your link or a code',
      body: `Your link is handsfreeos.com/?ref=yourname, with a name you pick. A business that signs up within ${affiliateRules.clickDays} days of clicking it is yours. Make discount and trial codes too, each with a link of its own.`,
    },
    {
      title: 'Get paid each month',
      body: `Each share waits ${affiliateRules.waitDays} days in case of a refund, then Stripe sends it to your bank with the next monthly payout, from ${affiliateRules.minPayout}. We pay Stripe’s fees.`,
    },
  ];

  return (
    <>
      <FaqJsonLd faqs={faqs} id={`${urls.site}/affiliates#faq`} />

      <Container className="py-16 sm:py-20">
        <Eyebrow>Affiliates</Eyebrow>
        <SectionHeading
          as="h1"
          sub={`Know small businesses that could use HandsFreeOS? Send them our way. When one pays for its plan, you earn ${share} of every payment it makes in its first ${affiliateRules.months} months, paid to your bank each month.`}
        >
          Sell HandsFreeOS. Earn {share} for a year.
        </SectionHeading>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button href={applyUrl} size="lg">
            Apply
          </Button>
          <Button href="/affiliates/terms" size="lg" variant="secondary">
            Read the terms
          </Button>
        </div>
      </Container>

      <Container className="pb-14">
        <ol className="grid gap-6 md:grid-cols-3">
          {steps.map((step, i) => (
            <li key={step.title}>
              <Card className="h-full">
                <p className="text-accent-text text-sm font-semibold">Step {i + 1}</p>
                <h2 className="mt-2 text-xl font-bold">{step.title}</h2>
                <p className="text-text-2 mt-3 text-base">{step.body}</p>
              </Card>
            </li>
          ))}
        </ol>
      </Container>

      {examples.length ? (
        <Section className="bg-card-2 border-border border-y">
          <SectionHeading
            sub={`At ${share}, here’s what one business earns you on each founding spot in its first year.`}
          >
            What one business earns you
          </SectionHeading>
          <div className="mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
            {examples.map((e) => (
              <Card key={e.id}>
                <h3 className="text-lg font-semibold">{e.name}</h3>
                <p className="text-text-3 mt-1 text-base">{e.price}</p>
                <p className="mt-5 text-4xl font-bold">
                  {e.each}
                  <span className="text-text-3 text-base font-normal"> {e.per}</span>
                </p>
                <p className="text-text-2 mt-2 text-base">
                  {e.firstYear
                    ? `${e.firstYear} in its first year`
                    : 'Paid once, for its first year'}
                </p>
              </Card>
            ))}
          </div>
          <p className="text-text-3 mt-6 max-w-3xl text-base">
            A discount from one of your codes lowers what the business pays, and your share is of
            what it pays.
          </p>
        </Section>
      ) : null}

      <Section>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr]">
          <SectionHeading>Everything on one page</SectionHeading>
          <ul className="grid gap-3 text-base sm:grid-cols-2">
            {[
              'Your link, ready to copy',
              'Clicks in the last 30 days, and in all',
              'How many businesses signed up through you',
              'The ones that pay, by name, and what each earned you',
              'What’s waiting, ready and paid',
              'Your discount and trial codes, on and off',
              'Your bank, set up on Stripe’s own page',
              'Every monthly payout',
            ].map((item) => (
              <li key={item} className="flex gap-2.5">
                <Check className="text-success mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section className="bg-card-2 border-border border-y" id="faq">
        <SectionHeading>What people ask</SectionHeading>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          {faqs.map((item) => (
            <div key={item.q}>
              <h3 className="text-lg font-semibold">{item.q}</h3>
              <p className="text-text-2 mt-2.5">{item.a}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold">Ready to start?</h2>
          <p className="text-text-2 mt-4 text-lg">
            Apply in a couple of minutes. Payouts are for people in the US, to a US bank account.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button href={applyUrl} size="lg">
              Apply
            </Button>
            <Button href="/affiliates/terms" size="lg" variant="secondary">
              Read the terms
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
