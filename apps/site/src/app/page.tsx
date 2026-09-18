import Link from 'next/link';
import {
  FaqJsonLd,
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
  WebSiteJsonLd,
} from '@/components/json-ld';
import { ProductMock } from '@/components/product-mock';
import { Button, Card, Check, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import { homeFaqs } from '@/content/faqs';
import { plans, urls } from '@/content/site';

/*
 * Headline variants worth testing against the one below, each on a different angle:
 *   1. "Stop losing jobs to the people who called back first."      (problem removal)
 *   2. "Answer every lead in seconds, even at 7pm on a Sunday."     (quantified speed)
 * The headline is the highest-leverage line on the page; change one thing at a time.
 */

export default function HomePage() {
  return (
    <>
      <OrganizationJsonLd />
      <WebSiteJsonLd />
      <SoftwareApplicationJsonLd />
      <FaqJsonLd faqs={homeFaqs} id={`${urls.site}/#faq`} />
      <Hero />
      <TheProblem />
      <HowItWorks />
      <Features />
      <WhyDifferent />
      <PlansStrip />
      <Questions />
      <FinalCta />
    </>
  );
}

function Hero() {
  return (
    <div className="relative overflow-hidden">
      <div className="hero-grid pointer-events-none absolute inset-0" aria-hidden="true" />
      <Container className="relative py-16 sm:py-24">
        <div className="grid items-center gap-14 lg:grid-cols-[1.05fr_1fr] lg:gap-16">
          <div>
            <h1 className="text-[2.5rem] leading-[1.06] font-bold sm:text-6xl">
              Your business keeps answering while you&rsquo;re on the job.
            </h1>
            <p className="text-text-2 mt-6 max-w-xl text-lg sm:text-xl">
              HandsFreeOS puts your calls, texts, email, calendar, quotes and invoices in one place
              — and gives you an AI teammate that answers a new lead in seconds, books them in, and
              checks with you before it does anything it hasn&rsquo;t earned yet.
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button href={urls.signUp} size="lg">
                Start free
              </Button>
              <Button href="/#how" size="lg" variant="secondary">
                See how it works
              </Button>
            </div>

            {/* FUD reducers sit directly under the button, and every one of them is true today. */}
            <ul className="text-text-2 mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm">
              {[
                'No card to start',
                'Keep the number you have',
                'Your money goes to your own Stripe or Square',
                'Cancel whenever',
              ].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check className="text-success" />
                  {item}
                </li>
              ))}
            </ul>

            {/*
              TODO (Chris): the strongest thing that can sit here is proof from real customers —
              a named review with a photo, a star rating, a count of businesses running on it.
              Until those exist, this stays factual about what it is rather than inventing praise.
            */}
            <dl className="border-border text-text-3 mt-10 grid gap-x-8 gap-y-4 border-t pt-6 text-sm sm:grid-cols-3">
              {[
                { term: 'Built and run by', detail: 'Go Biz Help LLC' },
                { term: 'Texting', detail: 'Registered with the carriers, the way the law asks' },
                { term: 'On the job', detail: 'iPhone and Android, working with no signal' },
              ].map((item) => (
                <div key={item.term}>
                  <dt className="text-text-3 text-xs font-semibold tracking-[0.1em] uppercase">
                    {item.term}
                  </dt>
                  <dd className="text-text-2 mt-1 ml-0">{item.detail}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="lg:pl-4">
            <ProductMock />
          </div>
        </div>
      </Container>
    </div>
  );
}

function TheProblem() {
  return (
    <Section className="bg-card-2 border-border border-y">
      <SectionHeading sub="Not because you're bad at your job. Because you were up a ladder when they texted, and by the time you got to your phone at 8pm they'd already booked the guy who answered.">
        The job you lost last week, you never even knew about.
      </SectionHeading>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {[
          {
            title: 'A lead goes cold in under an hour',
            body: 'People text three businesses and go with whoever answers first. Every hour you take to reply, fewer of them are still listening.',
          },
          {
            title: 'The quote you meant to send on Tuesday',
            body: 'It is still in your head, or half-written on a notepad in the van. Nobody chased it, so it quietly became a no.',
          },
          {
            title: 'Six apps that do not talk to each other',
            body: 'A texting app, a calendar, a spreadsheet, an invoicing tool, a notes app, and a phone with 40 unread messages. Nothing knows what anything else did.',
          },
        ].map((item) => (
          <Card key={item.title}>
            <h3 className="text-lg font-semibold">{item.title}</h3>
            <p className="text-text-2 mt-2.5">{item.body}</p>
          </Card>
        ))}
      </div>

      <p className="text-text mt-10 max-w-3xl text-xl font-semibold">
        HandsFreeOS answers while you work, writes the quote, chases it, takes the payment, and
        brings you in when something actually needs you.
      </p>
    </Section>
  );
}

function HowItWorks() {
  const steps = [
    {
      step: 'Week one',
      title: 'Your number, your customers, your calendar — moved over',
      body: 'Keep your existing business number or get a new one. Your customers come in from a spreadsheet, or straight out of the CRM you use today. Your Google or Outlook calendar plugs in so nothing gets double-booked.',
    },
    {
      step: 'Week two',
      title: 'It watches how you answer, and asks before it acts',
      body: 'The AI teammate drafts every reply and waits for your OK. You fix what is wrong. It learns your prices, your service area and the way you talk from a knowledge base you can read and edit.',
    },
    {
      step: 'From then on',
      title: 'It answers on its own, and hands you the ones that matter',
      body: 'Once a kind of reply has earned enough of your approvals, it sends on its own — and you can put that back any time. Anything it is unsure of, anything about money, and anything a customer gets upset about comes straight to you.',
    },
  ];
  return (
    <Section id="how">
      <Eyebrow>How it works</Eyebrow>
      <SectionHeading sub="It does not arrive on day one pretending to be you. It earns each job, one at a time, where you can see it.">
        You stay in charge. It just stops being the thing you do at 11pm.
      </SectionHeading>

      <ol className="mt-12 grid gap-6 md:grid-cols-3">
        {steps.map((item, index) => (
          <li key={item.title}>
            <Card className="h-full">
              <div className="flex items-center gap-3">
                <span className="bg-accent text-on-solid flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold">
                  {index + 1}
                </span>
                <span className="text-text-3 text-sm font-semibold tracking-[0.1em] uppercase">
                  {item.step}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold">{item.title}</h3>
              <p className="text-text-2 mt-2.5">{item.body}</p>
            </Card>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Features() {
  const features = [
    {
      title: 'Every text, call and email in one thread',
      body: 'One business number, one inbox the whole team shares. Missed calls turn into a text back before the customer has put their phone down. Voicemail comes through typed out.',
    },
    {
      title: 'Customers book themselves, at hours you set',
      body: 'A booking page for each service, round robin across your crew, or a whole day dispatched. Reminders go out by text and email, so fewer people forget you are coming.',
    },
    {
      title: 'Quotes they approve with their name',
      body: 'Send an estimate from your phone. They accept it on their own screen by typing their name. It becomes an invoice, and the invoice chases itself until it is paid.',
    },
    {
      title: 'The money lands in your account, not ours',
      body: 'Connect your own Stripe or Square. Card payments, deposits taken at booking, and plans that bill themselves every month settle into your balance. HandsFreeOS never holds your money.',
    },
    {
      title: 'One list of what needs you, money first',
      body: 'Home is not a dashboard of graphs. It is a ranked list: the hot lead waiting eleven minutes, the quote about to go stale, the invoice ten days late. The safe ones it just handles.',
    },
    {
      title: 'Ask it anything, in plain English',
      body: '"Who hasn’t paid me?" "Book Dale for Thursday morning." "Text everyone whose service is due." It answers from your real data, and shows you what it is about to change first.',
    },
  ];

  return (
    <Section id="features" className="bg-card-2 border-border border-y">
      <Eyebrow>What it does</Eyebrow>
      <SectionHeading sub="The parts of running a service business that eat your evenings, in one system that already knows who the customer is.">
        Six apps and a notepad, replaced by one.
      </SectionHeading>

      <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <Card key={feature.title} className="h-full">
            <h3 className="text-lg font-semibold">{feature.title}</h3>
            <p className="text-text-2 mt-2.5">{feature.body}</p>
          </Card>
        ))}
      </div>

      <div className="mt-10">
        <Button href="/features" variant="secondary" size="lg">
          Everything it does, in full
        </Button>
      </div>
    </Section>
  );
}

function WhyDifferent() {
  const points = [
    {
      title: 'The AI asks first, until you say it does not have to',
      body: 'Most AI tools give you a switch: off, or loose on your customers. This one starts by drafting and waiting, and only sends on its own once that kind of message has earned enough of your approvals. You can pull it back to asking at any time, for everything or just for prices.',
    },
    {
      title: 'It works with no signal, in a basement or out of town',
      body: 'The phone app is not a website in a wrapper. Everything can be read and changed offline and syncs when you come back. A text you wrote with no bars sends itself within half an hour, or asks "still send?" if it has been longer.',
    },
    {
      title: 'Your number and your customers stay yours',
      body: 'Keep the number people already have for you. Your customer list, your history and your files export whenever you want. Leaving is a thing you can actually do.',
    },
    {
      title: 'Registered for texting the way the carriers demand',
      body: 'Business texting in the US has to be registered, with real consent wording, or the carriers quietly drop your messages. That registration is part of setting you up, not a thing you find out about later.',
    },
  ];

  return (
    <Section>
      <Eyebrow>Why this one</Eyebrow>
      <SectionHeading sub="Plenty of tools will answer your customers automatically. The question is what happens the first time one of them gets it wrong.">
        Built to be trusted with your customers before it is trusted on its own.
      </SectionHeading>

      <div className="mt-12 grid gap-6 md:grid-cols-2">
        {points.map((point) => (
          <Card key={point.title} className="h-full">
            <h3 className="text-lg font-semibold">{point.title}</h3>
            <p className="text-text-2 mt-2.5">{point.body}</p>
          </Card>
        ))}
      </div>
    </Section>
  );
}

function PlansStrip() {
  return (
    <Section className="bg-card-2 border-border border-y">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading sub="One price a month, every feature in the plan, and texts and calls passed through at what they cost us.">
          Priced against the one job a month it saves you.
        </SectionHeading>
        <Button href="/pricing" variant="secondary" size="lg" className="shrink-0">
          See what is in each plan
        </Button>
      </div>

      <div className="mt-10 grid gap-4 sm:grid-cols-3">
        {plans.map((plan) => (
          <Link
            key={plan.id}
            href="/pricing"
            className="bg-card border-border hover:border-border-strong rounded-[var(--radius-card)] border p-5 transition-colors"
          >
            <p className="text-text-3 text-sm font-semibold tracking-[0.1em] uppercase">
              {plan.name}
            </p>
            <p className="mt-2 text-3xl font-bold">
              ${plan.price}
              <span className="text-text-3 text-base font-normal"> /month</span>
            </p>
            <p className="text-text-2 mt-2 text-base">{plan.blurb}</p>
          </Link>
        ))}
      </div>
    </Section>
  );
}

function Questions() {
  return (
    <Section>
      <SectionHeading sub="The things people actually ask before they sign up.">
        Fair questions.
      </SectionHeading>
      {/* Left open rather than hidden in accordions: what gets collapsed does not get read. */}
      <div className="mt-12 grid gap-8 md:grid-cols-2">
        {homeFaqs.map((item) => (
          <div key={item.q}>
            <h3 className="text-lg font-semibold">{item.q}</h3>
            <p className="text-text-2 mt-2.5">{item.a}</p>
          </div>
        ))}
      </div>
    </Section>
  );
}

function FinalCta() {
  return (
    <Section className="bg-card-2 border-border border-t">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-bold sm:text-4xl">
          The next lead texts you at 7pm. What happens?
        </h2>
        <p className="text-text-2 mt-5 text-lg">
          Set it up this week, watch every reply before it goes out, and let go of the ones it gets
          right. Start free — there is nothing to cancel if it is not for you.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button href={urls.signUp} size="lg">
            Start free
          </Button>
          <Button href="/support" size="lg" variant="secondary">
            Ask us a question first
          </Button>
        </div>
      </div>
    </Section>
  );
}
