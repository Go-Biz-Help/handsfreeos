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
import { featureSections, foundations } from '@/content/features';
import { spotPrices, urls } from '@/content/site';

export const metadata: Metadata = {
  title: 'What it does: AI answering, CRM and invoicing',
  description:
    'Missed-call text back, one inbox for texts and calls, online booking, estimates and invoices, automatic follow-ups, and an AI teammate that answers new leads.',
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

export default function FeaturesPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="Six or seven apps’ worth, in one system that notices what needs doing, does it, and brings you in when it matters. The less of it you end up touching, the better it’s working."
          as="h1"
        >
          Everything HandsFreeOS does, so you don&rsquo;t have to.
        </SectionHeading>

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
            {featureSections.map((section) => (
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

      <Section className="bg-card-2 border-border border-t">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold sm:text-4xl">All of that is on one plan.</h2>
          <p className="text-text-2 mt-5 text-lg">
            Every feature on this page, and as many people as work there, for {spotPrices}. Nothing
            is held back for a bigger plan, because there is no bigger plan.
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
