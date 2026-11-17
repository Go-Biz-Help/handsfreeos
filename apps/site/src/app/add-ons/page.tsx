import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AskChat } from '@/components/ask-chat';
import { Button, Card, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import {
  CoachVisual,
  ContentCalendarVisual,
  DealVisual,
  OutreachVisual,
} from '@/components/visuals';
import { addonCards, addonPriceLine, earlyAccess, type AddonCard } from '@/content/addons';
import { company, urls } from '@/content/site';

export const metadata: Metadata = {
  title: 'AI add-ons for outreach, posts and coaching',
  description:
    'Early access for founding members: AI that finds people on six social networks, writes your posts, coaches your sales calls and runs home sales.',
  alternates: { canonical: '/add-ons' },
};

/** One picture per add-on, drawn in visuals.tsx like the rest of the site. */
const visuals: Record<AddonCard['id'], ReactNode> = {
  outreach: <OutreachVisual />,
  socialcontent: <ContentCalendarVisual />,
  salescoach: <CoachVisual />,
  realestate: <DealVisual />,
};

/*
 * The add-ons, offered as early access (content/addons.ts says why). The plan is sold everywhere else on the site;
 * this page sells what goes on top of it, so it never says an add-on is included; each card says what it costs once
 * it's out of early access. Asking is the chat in the corner, which HandsFreeOS's own team answers, with the email beside it.
 */
export default function AddonsPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <Eyebrow>Add-ons · early access</Eyebrow>
        <SectionHeading
          as="h1"
          sub="HandsFreeOS answers the customers who come to you. These go out and find more of them, help you post, and help your team close. Founding members can ask for early access now."
        >
          Go find the next customer, not just answer them.
        </SectionHeading>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <AskChat>Ask for early access</AskChat>
          <Button href={urls.signUp} size="lg" variant="secondary">
            Get a founding spot first
          </Button>
        </div>

        <ul className="text-text-2 mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
          {[`For ${earlyAccess.who.toLowerCase()}`, earlyAccess.price, 'Turn one off any time'].map(
            (item) => (
              <li key={item} className="flex items-center gap-1.5">
                <Check className="text-success" />
                {item}
              </li>
            ),
          )}
        </ul>

        <nav aria-label="On this page" className="border-border mt-12 border-t pt-8">
          <ul className="flex flex-wrap gap-2">
            {addonCards.map((addon) => (
              <li key={addon.id}>
                <Link
                  href={`#${addon.id}`}
                  className="border-border bg-card hover:border-border-strong inline-flex rounded-full border px-4 py-2 text-base transition-colors"
                >
                  {addon.name}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>

      <div className="border-border border-t">
        {addonCards.map((addon, index) => (
          <section
            key={addon.id}
            id={addon.id}
            className={`scroll-mt-20 py-16 sm:py-20 ${
              index % 2 === 0 ? 'bg-card-2 border-border border-y' : ''
            }`}
          >
            <Container>
              <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
                <div>
                  <Eyebrow>{addon.who}</Eyebrow>
                  <h2 className="text-2xl leading-[1.1] font-bold tracking-[-0.025em] sm:text-3xl">
                    {addon.name}
                  </h2>
                  <p className="text-text-2 mt-4 text-lg">{addon.summary}</p>
                  <p
                    className="mt-3 text-base font-semibold"
                    data-testid={`addon-price-${addon.id}`}
                  >
                    {addonPriceLine(addon.id)}
                  </p>
                  <div className="mt-8">{visuals[addon.id]}</div>
                </div>

                <ul className="space-y-3.5 lg:pt-14">
                  {addon.points.map((point) => (
                    <li key={point} className="flex gap-3">
                      <Check className="text-success mt-0.5" />
                      <span className="text-text-2 text-[1.0625rem]">{point}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </Container>
          </section>
        ))}
      </div>

      <Section id="early-access" className="border-border border-t">
        <SectionHeading sub={`${earlyAccess.later} ${earlyAccess.usage}`}>
          How early access works.
        </SectionHeading>
        <ol className="mt-12 grid gap-6 md:grid-cols-3">
          {[
            {
              title: 'Have a founding spot',
              body: 'Early access is for founding members. No spot yet? Start the free trial and pick one.',
            },
            {
              title: 'Ask for the add-on',
              body: `Tell us which one in the chat, or email ${company.supportEmail} from the address you sign in with.`,
            },
            {
              title: 'We turn it on',
              body: 'It shows up in your menu, ready to set up. Turn it off whenever you like.',
            },
          ].map((step, index) => (
            <li key={step.title}>
              <Card className="h-full">
                <p className="text-accent-text text-sm font-semibold tabular-nums">{index + 1}</p>
                <h3 className="mt-2 text-lg font-semibold">{step.title}</h3>
                <p className="text-text-2 mt-2.5">{step.body}</p>
              </Card>
            </li>
          ))}
        </ol>
        <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
          <AskChat>Ask for early access</AskChat>
          <a
            href={`mailto:${company.supportEmail}?subject=${encodeURIComponent('Early access to an add-on')}`}
            className="text-text-2 hover:text-text px-2 text-base underline underline-offset-2"
          >
            Or email {company.supportEmail}
          </a>
        </div>
      </Section>
    </>
  );
}
