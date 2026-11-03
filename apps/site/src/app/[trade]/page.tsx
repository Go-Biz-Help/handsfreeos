import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { BillBuilder } from '@/components/bill-builder';
import { NightBand } from '@/components/night-band';
import { ProductMock } from '@/components/product-mock';
import { Reveal } from '@/components/reveal';
import { StickyCta } from '@/components/sticky-cta';
import { Button, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import {
  MissedLeadForYou,
  TryItOnYourBusiness,
  YourBusinessName,
  YourBusinessProvider,
} from '@/components/your-business';
import { pricesCheckedOn, stackSources } from '@/content/savings';
import { moneyBack, spotPrices, urls } from '@/content/site';
import { tradePageBySlug, tradePages } from '@/content/trade-pages';
import { foundingCounts, foundingSpotsOnSale, hasRoom } from '@/lib/founding';

/**
 * A trade's own page (content/trade-pages.ts): the home page's story, told for one trade from the first line. The
 * example conversation and the lead lost at night are the trade's own from content/trades.ts, and "Try it on your
 * business" asks only for the name, since the trade is already this one.
 */

type Props = { params: Promise<{ trade: string }> };

/** The sign-up button says "Claim my founding spot" only while one is open, so it reads the live counts. */
export const revalidate = 60;
export const dynamicParams = false;

export function generateStaticParams() {
  return tradePages.map((p) => ({ trade: p.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const page = tradePageBySlug((await params).trade);
  if (!page) return {};
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/${page.slug}` },
  };
}

export default async function TradePage({ params }: Props) {
  const page = tradePageBySlug((await params).trade);
  if (!page) notFound();
  const open = foundingSpotsOnSale(await foundingCounts()).some(hasRoom);
  const signUp = open ? 'Claim my founding spot' : 'Sign up';

  return (
    <>
      <YourBusinessProvider trade={page.trade}>
        <div className="relative overflow-hidden">
          <div className="hero-glow pointer-events-none absolute inset-0" aria-hidden="true" />
          <Container className="relative pt-10 pb-20 sm:pt-14 sm:pb-28 lg:pt-20">
            <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] lg:gap-14">
              <div>
                <Eyebrow>HandsFreeOS for {page.who.toLowerCase()}</Eyebrow>
                <h1 className="text-[2.5rem] leading-[1] font-bold tracking-[-0.045em] sm:text-6xl lg:text-[3.75rem]">
                  {page.h1}
                </h1>
                <p className="text-text-2 mt-7 max-w-xl text-lg sm:text-xl">{page.sub}</p>
                <p className="text-text mt-5 max-w-xl text-lg font-semibold sm:text-xl">
                  And it asks you first, until it has earned your trust.
                </p>
                <div
                  data-cta="hero"
                  className="mt-9 flex flex-col gap-3 sm:flex-row sm:items-center"
                >
                  <Button href={urls.signUp} size="lg" arrow>
                    {signUp}
                  </Button>
                  <Button href="/pricing" size="lg" variant="secondary">
                    See the price
                  </Button>
                </div>
                <ul className="text-text-2 mt-6 flex flex-wrap gap-x-5 gap-y-2 text-sm">
                  {[`${spotPrices}, plus what you use`, 'No contract', moneyBack.short].map(
                    (item) => (
                      <li key={item} className="flex items-center gap-1.5">
                        <Check className="text-success" />
                        {item}
                      </li>
                    ),
                  )}
                </ul>
              </div>
              <div className="min-w-0 lg:pl-2">
                <TryItOnYourBusiness />
                <ProductMock />
              </div>
            </div>
          </Container>
        </div>

        <NightBand>
          <div className="grid items-center gap-14 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:gap-16">
            <h2 className="text-on-night text-[2.125rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl">
              {page.night}
            </h2>
            <Reveal>
              <MissedLeadForYou />
            </Reveal>
          </div>
          <div className="border-night-border mt-16 grid gap-10 border-t pt-10 md:grid-cols-3">
            {page.pains.map((pain) => (
              <div key={pain.title}>
                <h3 className="text-on-night text-lg font-semibold">{pain.title}</h3>
                <p className="text-on-night-2 mt-2.5">{pain.body}</p>
              </div>
            ))}
          </div>
        </NightBand>

        <Section>
          <Eyebrow>What it takes off you</Eyebrow>
          <SectionHeading sub="The parts of the week that eat your evenings, done on their own. Every one of them is in the plan.">
            Built around the way {page.who.toLowerCase()} work.
          </SectionHeading>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 sm:gap-6">
            {page.jobs.map((job) => (
              <div
                key={job.title}
                className="bg-card border-border rounded-[20px] border p-6 shadow-[var(--shadow-1)] sm:p-8"
              >
                <h3 className="text-xl leading-snug font-semibold tracking-[-0.015em]">
                  {job.title}
                </h3>
                <p className="text-text-2 mt-3">{job.body}</p>
              </div>
            ))}
          </div>
          <Button href="/features" variant="secondary" className="mt-10" arrow>
            Everything it does, in full
          </Button>
        </Section>

        <Section className="bg-card-2 border-border border-y">
          <div className="grid items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,28rem)] lg:gap-16">
            <div>
              <Eyebrow>The bill</Eyebrow>
              <SectionHeading sub="Untick the tools you don’t pay for, and see what comes back a year. No charge per person, so hiring your next tech doesn’t change it.">
                One bill instead of ten.
              </SectionHeading>
              <p className="text-text-3 mt-8 max-w-xl text-sm">
                Each company&rsquo;s public price for the plan shown, checked {pricesCheckedOn}:{' '}
                {stackSources.map((s, index) => (
                  <span key={s.source}>
                    {index > 0 ? ', ' : ''}
                    <a
                      href={s.source}
                      rel="noreferrer noopener"
                      className="underline underline-offset-2"
                      target="_blank"
                    >
                      {s.company}
                    </a>
                  </span>
                ))}
                .
              </p>
            </div>
            <div className="bg-card border-border rounded-[20px] border p-6 shadow-[var(--shadow-2)] sm:p-8">
              <BillBuilder />
            </div>
          </div>
        </Section>

        <NightBand className="text-center">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-on-night text-[2.25rem] leading-[1.04] font-bold tracking-[-0.035em] [overflow-wrap:anywhere] sm:text-5xl">
              The next lead texts <YourBusinessName fallback="you" /> tonight. Who answers?
            </h2>
            <p className="text-on-night-2 mt-6 text-lg">
              Set it up this week. Watch every reply before it goes out, and let go of the ones it
              gets right. If it isn&rsquo;t for you within {moneyBack.days} days, you get your money
              back.
            </p>
            <div data-cta="final" className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
              <Button href={urls.signUp} size="lg" arrow>
                {signUp}
              </Button>
              <Button href="/support" size="lg" variant="night">
                Ask us a question first
              </Button>
            </div>
          </div>
        </NightBand>
      </YourBusinessProvider>

      <Container className="py-12">
        <p className="text-text-2">
          HandsFreeOS for other trades:{' '}
          {tradePages
            .filter((p) => p.slug !== page.slug)
            .map((p, index) => (
              <span key={p.slug}>
                {index > 0 ? ', ' : ''}
                <Link
                  href={`/${p.slug}`}
                  className="text-accent-text font-semibold underline-offset-2 hover:underline"
                >
                  {p.who.toLowerCase()}
                </Link>
              </span>
            ))}
          .
        </p>
      </Container>
      <StickyCta open={open} />
    </>
  );
}
