import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button, Card, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import {
  ActionCenterVisual,
  AssistantVisual,
  BookingVisual,
  InboxVisual,
  MigrationVisual,
  MoneyVisual,
  PipelineVisual,
  TrustLadderVisual,
  WorkflowVisual,
} from '@/components/visuals';
import { automationGroups, comingSoon, featureSections, foundations } from '@/content/features';
import { moneyBack, spotPrices, urls } from '@/content/site';

/** How many things it does on its own: the same list as Settings → Automations in the app. */
const automationCount = automationGroups.reduce((sum, group) => sum + group.items.length, 0);

export const metadata: Metadata = {
  title: 'What it does: AI answering, CRM and invoicing',
  description: `AI that answers calls and texts, one inbox, online booking, quotes and invoices, video calls, campaigns, reviews, forms and ${automationCount} automations, on one plan.`,
  alternates: { canonical: '/features' },
};

/** One picture per section, in the same order the sections are written. */
const visuals: Record<string, ReactNode> = {
  inbox: <InboxVisual />,
  customers: <PipelineVisual />,
  calendar: <BookingVisual />,
  money: <MoneyVisual />,
  ai: <TrustLadderVisual />,
  assistant: <AssistantVisual />,
  workflows: <WorkflowVisual />,
  'action-center': <ActionCenterVisual />,
  mobile: (
    <div className="border-border-strong bg-card mx-auto max-w-[15rem] overflow-hidden rounded-[18px] border shadow-[var(--shadow-2)]">
      <Image
        src="/screenshots/home.png"
        alt="The HandsFreeOS app on a phone, showing what needs attention with the money affected at the top."
        width={1080}
        height={1920}
        sizes="(max-width: 1024px) 60vw, 15rem"
        className="h-auto w-full"
      />
    </div>
  ),
  'moving-in': <MigrationVisual />,
};

/** The jump list: every section on the page, then the two lists after them. */
const jumps = [
  ...featureSections.map((section) => ({ id: section.id, nav: section.nav })),
  { id: 'automations', nav: 'All automations' },
  { id: 'coming-soon', nav: 'Coming soon' },
];

export default function FeaturesPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="Ten apps’ worth, in one system that notices what needs doing, does it, and brings you in when it matters. It answers, books, quotes, chases, meets and markets, and keeps every record current on its own."
          as="h1"
        >
          Everything HandsFreeOS does, so you don&rsquo;t have to.
        </SectionHeading>

        <ul className="mt-8 flex flex-wrap gap-x-8 gap-y-3 text-base">
          {[
            { strong: String(automationCount), rest: 'automations, each with its own switch' },
            { strong: 'One AI', rest: 'across every part, asking first' },
            { strong: 'One plan', rest: 'with every feature and unlimited people' },
          ].map((item) => (
            <li key={item.rest} className="text-text-2">
              <span className="text-text font-bold">{item.strong}</span> {item.rest}
            </li>
          ))}
        </ul>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg">
            Sign up
          </Button>
          <Button href="/pricing" size="lg" variant="secondary">
            See pricing
          </Button>
        </div>

        {/* A plain jump list: everything below is on this page, nothing is hidden behind a tab. */}
        <nav aria-label="On this page" className="border-border mt-12 border-t pt-8">
          <p className="text-text-3 mb-4 text-sm font-medium">On this page</p>
          <ul className="flex flex-wrap gap-2">
            {jumps.map((section) => (
              <li key={section.id}>
                <Link
                  href={`#${section.id}`}
                  className="border-border bg-card hover:border-border-strong inline-flex rounded-full border px-4 py-2 text-base transition-colors"
                >
                  {section.nav}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </Container>

      <div className="border-border border-t">
        {featureSections.map((section, index) => (
          <section
            key={section.id}
            id={section.id}
            className={`scroll-mt-20 py-16 sm:py-20 ${
              index % 2 === 1 ? 'bg-card-2 border-border border-y' : ''
            }`}
          >
            <Container>
              <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
                <div>
                  <Eyebrow>{section.nav}</Eyebrow>
                  <h2 className="text-2xl leading-[1.1] font-bold tracking-[-0.025em] sm:text-3xl">
                    {section.title}
                  </h2>
                  <p className="text-text-2 mt-4 text-lg">{section.intro}</p>
                  {section.id === 'mobile' ? (
                    <Button href="/app" variant="secondary" className="mt-6">
                      More about the phone app
                    </Button>
                  ) : null}
                  <div className="mt-8">{visuals[section.id]}</div>
                </div>

                <ul className="space-y-3.5 lg:pt-14">
                  {section.points.map((point) => (
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

      {/*
       * The whole of Settings → Automations, because "it follows up for you" means more when you can count it. Left
       * open rather than folded away, in columns, so 50 lines read as a list rather than a wall.
       */}
      <Section id="automations" className="border-border border-t">
        <Eyebrow>All automations</Eyebrow>
        <SectionHeading
          sub={`Every one of these runs by itself once it’s on, and every one has its own switch in Settings → Automations, with what it does written in plain words beside it.`}
        >
          {automationCount} things it does without being asked.
        </SectionHeading>
        <div className="mt-12 gap-6 md:columns-2 lg:columns-3">
          {automationGroups.map((group) => (
            <Card key={group.title} className="mb-6 break-inside-avoid">
              <h3 className="flex items-baseline justify-between gap-3 text-lg font-semibold">
                {group.title}
                <span className="text-text-3 text-sm font-medium tabular-nums">
                  {group.items.length}
                </span>
              </h3>
              <ul className="mt-4 space-y-3.5">
                {group.items.map((item) => (
                  <li key={item.label} className="flex gap-2.5">
                    <Check className="text-success mt-0.5" />
                    <p className="text-text-2 text-base">
                      <span className="text-text font-semibold">
                        {/[.?!]$/.test(item.label) ? item.label : `${item.label}.`}
                      </span>{' '}
                      {item.does}
                    </p>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </Section>

      <Section className="border-border border-t">
        <SectionHeading sub="The parts nobody puts on a website, which matter the first time something goes wrong.">
          Underneath all of it.
        </SectionHeading>
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {foundations.map((item) => (
            <Card key={item.title} className="h-full">
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-text-2 mt-2.5">{item.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      {/* Said plainly, so nothing above has to pretend: none of these is counted anywhere else on the site. */}
      <Section id="coming-soon" className="border-border border-t">
        <Eyebrow>Coming soon</Eyebrow>
        <SectionHeading sub="Built, or being built, and not switched on for everyone yet. We’ll move each one up this page when it is.">
          What&rsquo;s on its way.
        </SectionHeading>
        <ul className="mt-12 grid gap-x-10 gap-y-8 md:grid-cols-2 lg:grid-cols-3">
          {comingSoon.map((item) => (
            <li key={item.title} className="border-border border-t pt-5">
              <p className="text-accent-text text-sm font-semibold">{item.when}</p>
              <h3 className="mt-2 text-lg font-semibold">{item.title}</h3>
              <p className="text-text-2 mt-2">{item.body}</p>
            </li>
          ))}
        </ul>
      </Section>

      <Section className="bg-card-2 border-border border-t">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">All of that is on one plan.</h2>
          <p className="text-text-2 mt-5 text-lg">
            Every feature above the coming-soon list, and as many people as work there, for{' '}
            {spotPrices}. Nothing is held back for a bigger plan, because there is no bigger plan.
            And if it isn&rsquo;t for you within {moneyBack.days} days, you get your money back.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button href={urls.signUp} size="lg">
              Sign up
            </Button>
            <Button href="/pricing" size="lg" variant="secondary">
              See what it costs
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
