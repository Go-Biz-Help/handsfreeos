import type { Metadata } from 'next';
import Link from 'next/link';
import { Button, Card, Check, Container, Section, SectionHeading } from '@/components/ui';
import { featureSections, foundations } from '@/content/features';
import { urls } from '@/content/site';

export const metadata: Metadata = {
  title: 'What it does: AI answering, CRM and invoicing',
  description:
    'Missed-call text back, one inbox for texts and calls, online booking, estimates and invoices, automatic follow-ups, and an AI teammate that answers new leads.',
  alternates: { canonical: '/features' },
};

export default function FeaturesPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="Six or seven apps’ worth, in one system that already knows who the customer is. Here is the whole of it, in plain English."
          as="h1"
        >
          Everything HandsFreeOS does.
        </SectionHeading>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg">
            Start free
          </Button>
          <Button href="/pricing" size="lg" variant="secondary">
            See pricing
          </Button>
        </div>

        {/* A plain jump list: everything below is on this page, nothing is hidden behind a tab. */}
        <nav aria-label="On this page" className="border-border mt-12 border-t pt-8">
          <p className="text-text-3 mb-4 text-xs font-semibold tracking-[0.12em] uppercase">
            On this page
          </p>
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
                  <p className="text-accent-text mb-3 text-xs font-semibold tracking-[0.14em] uppercase">
                    {section.nav}
                  </p>
                  <h2 className="text-2xl leading-[1.15] font-bold sm:text-3xl">{section.title}</h2>
                  <p className="text-text-2 mt-4 text-lg">{section.intro}</p>
                  {section.id === 'mobile' ? (
                    <Button href="/app" variant="secondary" className="mt-6">
                      More about the phone app
                    </Button>
                  ) : null}
                </div>

                <ul className="space-y-3.5">
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
            Growth is every feature on this page, for one business — nothing is held back for a
            bigger plan. Starter is the smaller version for a one-person shop, and Pro is for
            running more than one business.
          </p>
          <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
            <Button href={urls.signUp} size="lg">
              Start free
            </Button>
            <Button href="/pricing" size="lg" variant="secondary">
              See what each plan costs
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}
