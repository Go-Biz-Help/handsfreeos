import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FaqJsonLd } from '@/components/json-ld';
import { NightBand } from '@/components/night-band';
import { Button, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import { comparedOn, competitorById, competitors } from '@/content/compare';
import { ours, usd } from '@/content/savings';
import { moneyBack, spotPrices, urls } from '@/content/site';
import { foundingCounts, foundingSpotsOnSale, hasRoom } from '@/lib/founding';

/**
 * HandsFreeOS beside one tool people already pay for (content/compare.ts says what may go on one): the table of
 * checked prices first, then what is different, then when the other tool is the better pick, then moving over.
 */

type Props = { params: Promise<{ id: string }> };

/** The sign-up button says "Claim my founding spot" only while one is open, so it reads the live counts. */
export const revalidate = 60;
export const dynamicParams = false;

export function generateStaticParams() {
  return competitors.map((c) => ({ id: c.id }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const competitor = competitorById((await params).id);
  if (!competitor) return {};
  return {
    title: competitor.title,
    description: competitor.description,
    alternates: { canonical: `/vs/${competitor.id}` },
  };
}

export default async function ComparePage({ params }: Props) {
  const competitor = competitorById((await params).id);
  if (!competitor) notFound();
  const open = foundingSpotsOnSale(await foundingCounts()).some(hasRoom);
  const others = competitors.filter((c) => c.id !== competitor.id);
  const saving = competitor.theirTotal.monthly - ours.high;

  return (
    <>
      <FaqJsonLd faqs={competitor.faqs} id={`${urls.site}/vs/${competitor.id}#faq`} />
      <Container className="pt-12 pb-16 sm:pt-16 sm:pb-20">
        <Eyebrow>Compare</Eyebrow>
        <SectionHeading as="h1" sub={competitor.intro}>
          {competitor.h1}
        </SectionHeading>
        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg" arrow>
            {open ? 'Claim my founding spot' : 'Sign up'}
          </Button>
          <Button href="#table" size="lg" variant="secondary">
            See them side by side
          </Button>
        </div>
      </Container>

      <Section id="table" className="bg-card-2 border-border border-y">
        <h2 className="text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
          Side by side, for {competitor.example.toLowerCase()}
        </h2>
        <div className="bg-card border-border mt-8 overflow-hidden rounded-[20px] border shadow-[var(--shadow-2)]">
          <table className="w-full border-collapse text-left">
            <caption className="sr-only">
              {competitor.name} and HandsFreeOS compared, from {competitor.name}&rsquo;s pricing
              page on {comparedOn}
            </caption>
            <thead>
              <tr className="border-border border-b">
                <th
                  scope="col"
                  className="text-text-3 w-[30%] px-4 py-4 text-sm font-medium sm:px-6"
                >
                  <span className="sr-only">What</span>
                </th>
                <th scope="col" className="text-text-2 px-4 py-4 text-sm font-semibold sm:px-6">
                  {competitor.name}
                </th>
                <th
                  scope="col"
                  className="text-accent-text bg-accent-soft px-4 py-4 text-sm font-semibold sm:px-6"
                >
                  HandsFreeOS
                </th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {competitor.rows.map((row) => (
                <tr key={row.what} className="align-top">
                  <th
                    scope="row"
                    className="text-text px-4 py-4 text-sm font-semibold sm:px-6 sm:text-base"
                  >
                    {row.what}
                  </th>
                  <td className="text-text-2 px-4 py-4 text-sm sm:px-6 sm:text-base">{row.them}</td>
                  <td className="text-text bg-accent-soft/50 px-4 py-4 text-sm font-medium sm:px-6 sm:text-base">
                    {row.us}
                  </td>
                </tr>
              ))}
              <tr className="border-border-strong border-t-2 align-top">
                <th
                  scope="row"
                  className="text-text px-4 py-5 text-sm font-bold sm:px-6 sm:text-base"
                >
                  A month, in all
                </th>
                <td className="px-4 py-5 sm:px-6">
                  <span className="text-text-2 block text-lg font-bold tabular-nums">
                    {usd(competitor.theirTotal.monthly)}
                  </span>
                  <span className="text-text-3 block text-sm">{competitor.theirTotal.parts}</span>
                </td>
                <td className="bg-accent-soft/50 px-4 py-5 sm:px-6">
                  <span className="text-text block text-lg font-bold tabular-nums">
                    {usd(ours.low)}–{usd(ours.high)}
                  </span>
                  <span className="text-text-3 block text-sm">The plan and the usage most see</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {saving > 0 ? (
          <p className="text-text mt-6 text-lg font-semibold">
            That&rsquo;s at least {usd(saving)} a month less, before anything else you&rsquo;d stop
            paying for.
          </p>
        ) : null}
        <p className="text-text-3 mt-4 max-w-3xl text-sm">
          {competitor.name}&rsquo;s prices are its public list prices for monthly billing, read off{' '}
          <a
            href={competitor.source}
            rel="noreferrer noopener"
            target="_blank"
            className="underline underline-offset-2"
          >
            its pricing page
          </a>{' '}
          on {comparedOn}; check there for today&rsquo;s. HandsFreeOS is the $97 monthly founding
          spot plus the usage most businesses see. {competitor.name} is a trademark of its owner,
          who has nothing to do with this page.
        </p>
      </Section>

      <Section>
        <Eyebrow>What&rsquo;s different</Eyebrow>
        <SectionHeading>What you get with HandsFreeOS</SectionHeading>
        <div className="mt-12 grid gap-5 sm:grid-cols-2 sm:gap-6">
          {competitor.different.map((item) => (
            <div
              key={item.title}
              className="bg-card border-border rounded-[20px] border p-6 shadow-[var(--shadow-1)] sm:p-8"
            >
              <h3 className="text-xl leading-snug font-semibold tracking-[-0.015em]">
                {item.title}
              </h3>
              <p className="text-text-2 mt-3">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section className="border-border border-t">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              When {competitor.name} is the better pick
            </h2>
            <ul className="mt-6 grid gap-4">
              {competitor.theyFit.map((item) => (
                <li key={item} className="text-text-2 flex gap-3 text-[1.0625rem]">
                  <Check className="text-text-3 mt-0.5" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h2 className="text-2xl font-bold tracking-[-0.02em] sm:text-3xl">
              Moving from {competitor.name}
            </h2>
            <p className="text-text-2 mt-6 text-[1.0625rem]">{competitor.moving}</p>
          </div>
        </div>
      </Section>

      <Section id="faq" className="border-border border-t">
        <h2 className="text-2xl font-bold tracking-[-0.02em] sm:text-3xl">Fair questions</h2>
        <div className="mt-8 grid gap-x-12 md:grid-cols-2">
          {competitor.faqs.map((item) => (
            <div key={item.q} className="border-border border-t py-7">
              <h3 className="text-lg leading-snug font-semibold">{item.q}</h3>
              <p className="text-text-2 mt-3">{item.a}</p>
            </div>
          ))}
        </div>
        {others.length > 0 ? (
          <p className="text-text-2 mt-8">
            Also compared:{' '}
            {others.map((c, index) => (
              <span key={c.id}>
                {index > 0 ? ', ' : ''}
                <Link
                  href={`/vs/${c.id}`}
                  className="text-accent-text font-semibold underline underline-offset-2"
                >
                  HandsFreeOS vs {c.name}
                </Link>
              </span>
            ))}
            .
          </p>
        ) : null}
      </Section>

      <NightBand className="text-center">
        <div className="mx-auto max-w-2xl">
          <h2 className="text-on-night text-[2.25rem] leading-[1.04] font-bold tracking-[-0.035em] sm:text-5xl">
            Try it beside {competitor.name} for 30 days.
          </h2>
          <p className="text-on-night-2 mt-6 text-lg">
            {spotPrices}, plus what you use. No contract. If it isn&rsquo;t for you within{' '}
            {moneyBack.days} days, you get your plan payment back.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Button href={urls.signUp} size="lg" arrow>
              {open ? 'Claim my founding spot' : 'Sign up'}
            </Button>
            <Button href="/support" size="lg" variant="night">
              Ask us a question first
            </Button>
          </div>
        </div>
      </NightBand>
    </>
  );
}
