import Image from 'next/image';
import Link from 'next/link';
import {
  FaqJsonLd,
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
  WebSiteJsonLd,
} from '@/components/json-ld';
import { IconBadge, Icons } from '@/components/icons';
import { ProductMock } from '@/components/product-mock';
import { TrustLadderVisual } from '@/components/visuals';
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
      <ConnectedAccounts />
      <InYourPocket />
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
            {/*
             * The product name leads the page. Google's OAuth review checks that the name on the
             * consent screen is the name a visitor sees here, and a wordmark in the nav bar is not
             * what it reads. Keep this string identical to the consent screen's app name.
             */}
            <Eyebrow>HandsFreeOS</Eyebrow>
            <h1 className="text-[2.5rem] leading-[1.06] font-bold sm:text-6xl">
              Your business keeps answering while you&rsquo;re on the job.
            </h1>
            <p className="text-text-2 mt-6 max-w-xl text-lg sm:text-xl">
              HandsFreeOS puts your calls, texts, email, calendar, quotes and invoices in one place
              — with an AI teammate that answers new leads in seconds, books them in, and checks
              with you first.
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
              {['No card to start', 'Keep the number you have', 'Cancel whenever'].map((item) => (
                <li key={item} className="flex items-center gap-1.5">
                  <Check className="text-success" />
                  {item}
                </li>
              ))}
            </ul>
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

      {/* A sequence, so it is drawn as one: a rule the steps sit on, not three separate cards. */}
      <ol className="relative mt-14 grid gap-12 md:grid-cols-3 md:gap-8">
        <span
          aria-hidden="true"
          className="bg-border absolute top-4 right-8 left-8 hidden h-px md:block"
        />
        {steps.map((item, index) => (
          <li key={item.title} className="relative">
            <div className="mb-5 flex items-center gap-3">
              <span className="bg-accent text-white ring-bg relative z-10 flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ring-8">
                {index + 1}
              </span>
              <span className="text-text-3 bg-bg relative z-10 pr-3 text-sm font-semibold tracking-[0.1em] uppercase">
                {item.step}
              </span>
            </div>
            <h3 className="text-lg font-semibold">{item.title}</h3>
            <p className="text-text-2 mt-2.5">{item.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Features() {
  const features = [
    {
      icon: Icons.inbox,
      title: 'Every text, call and email in one thread',
      body: 'One business number, one inbox the whole team shares. Missed calls turn into a text back before the customer has put their phone down. Voicemail comes through typed out.',
    },
    {
      icon: Icons.calendar,
      title: 'Customers book themselves, at hours you set',
      body: 'A booking page for each service, round robin across your crew, or a whole day dispatched. Reminders go out by text and email, so fewer people forget you are coming.',
    },
    {
      icon: Icons.receipt,
      title: 'Quotes they approve with their name',
      body: 'Send an estimate from your phone. They accept it on their own screen by typing their name. It becomes an invoice, and the invoice chases itself until it is paid.',
    },
    {
      icon: Icons.card,
      title: 'The money lands in your account, not ours',
      body: 'Connect your own Stripe or Square. Card payments, deposits taken at booking, and plans that bill themselves every month settle into your balance. HandsFreeOS never holds your money.',
    },
    {
      icon: Icons.list,
      title: 'One list of what needs you, money first',
      body: 'Home is not a dashboard of graphs. It is a ranked list: the hot lead waiting eleven minutes, the quote about to go stale, the invoice ten days late. The safe ones it just handles.',
    },
    {
      icon: Icons.spark,
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
            <IconBadge>
              <feature.icon />
            </IconBadge>
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

/*
 * What HandsFreeOS does with a connected Google or Microsoft account, in plain sight on the home
 * page rather than only in the privacy policy. Google's OAuth verification reads this page to
 * decide whether the app's purpose explains the scopes it asks for, so each line here is meant to
 * map onto one: busy times to calendar.freebusy, appointments written back to
 * calendar.events.owned, and the mailbox scopes to the shared inbox.
 */
function ConnectedAccounts() {
  const connections = [
    {
      icon: Icons.calendar,
      title: 'Your Google or Outlook calendar',
      body: 'HandsFreeOS reads when you are busy — the times only, never what the events are — so customers booking online and teammates booking for you cannot put a job on top of something you already have. Your HandsFreeOS appointments are written back to that calendar as events with no guests, so the day on your phone is the whole day.',
    },
    {
      icon: Icons.inbox,
      title: 'Your Gmail or Outlook mailbox',
      body: 'Email lands in the same thread as that customer’s texts and calls, and replies you write go out from your own address. One place to look, whichever way the customer got in touch.',
    },
    {
      icon: Icons.shield,
      title: 'What it never does',
      body: 'It does not read your event titles, show your other events to anyone, or change anything in your calendar that it did not put there. Nothing is used for advertising and nothing is sold. Disconnect in Settings and the access stops and what was stored is deleted.',
    },
  ];

  return (
    <Section id="connects">
      <Eyebrow>Connected accounts</Eyebrow>
      <SectionHeading sub="HandsFreeOS is the system a small service business runs its customers on: one business number, one shared inbox, a calendar customers book themselves on, and the quotes and invoices that follow. It connects to the calendar and mailbox you already use so you do not have to keep two of anything in step by hand.">
        It works with the calendar and inbox you already have.
      </SectionHeading>

      <div className="mt-12 grid gap-6 md:grid-cols-3">
        {connections.map((item) => (
          <Card key={item.title} className="h-full">
            <IconBadge>
              <item.icon />
            </IconBadge>
            <h3 className="text-lg font-semibold">{item.title}</h3>
            <p className="text-text-2 mt-2.5">{item.body}</p>
          </Card>
        ))}
      </div>

      <p className="text-text-2 mt-10 max-w-3xl">
        HandsFreeOS&rsquo;s use of information received from Google APIs follows the{' '}
        <Link href="/privacy#google" className="text-accent-text font-semibold underline">
          Google API Services User Data Policy
        </Link>
        , including the Limited Use requirements.
      </p>
    </Section>
  );
}

function WhyDifferent() {
  const points = [
    {
      icon: Icons.shield,
      title: 'The AI asks first, until you say it does not have to',
      body: 'Most AI tools give you a switch: off, or loose on your customers. This one starts by drafting and waiting, and only sends on its own once that kind of message has earned enough of your approvals.',
    },
    {
      icon: Icons.phone,
      title: 'It works with no signal, in a basement or out of town',
      body: 'The phone app is not a website in a wrapper. Everything can be read and changed offline and syncs when you come back. A text you wrote with no bars sends itself within half an hour, or asks “still send?” if it has been longer.',
    },
    {
      icon: Icons.swap,
      title: 'Your number and your customers stay yours',
      body: 'Keep the number people already have for you. Your customer list, your history and your files export whenever you want. Leaving is a thing you can actually do.',
    },
    {
      icon: Icons.bolt,
      title: 'Registered for texting the way the carriers demand',
      body: 'US business texting has to be registered, with real consent wording, or the carriers quietly drop your messages. That registration is part of setting you up, not a thing you find out about later.',
    },
  ];

  return (
    <Section>
      <Eyebrow>Why this one</Eyebrow>
      <SectionHeading sub="Plenty of tools will answer your customers automatically. The question is what happens the first time one of them gets it wrong.">
        Built to be trusted with your customers before it is trusted on its own.
      </SectionHeading>

      <div className="mt-12 grid items-start gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:gap-16">
        <ul className="space-y-8">
          {points.map((point) => (
            <li key={point.title} className="flex gap-4">
              <span className="bg-accent-soft-2 text-accent-text flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px]">
                <point.icon />
              </span>
              <div>
                <h3 className="text-lg font-semibold">{point.title}</h3>
                <p className="text-text-2 mt-2">{point.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="lg:sticky lg:top-24">
          <TrustLadderVisual />
        </div>
      </div>
    </Section>
  );
}

/** Real screens from the app, because the crew using it will never see a desktop. */
function InYourPocket() {
  const shots = [
    { src: '/screenshots/home.png', alt: 'The app showing what needs attention, money first.' },
    {
      src: '/screenshots/offline-queue.png',
      alt: 'The app showing changes made with no signal, waiting to send.',
    },
    { src: '/screenshots/invoice.png', alt: 'An invoice in the app, ready to send to a customer.' },
  ];
  return (
    <Section className="bg-card-2 border-border border-y">
      <div className="grid items-center gap-12 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] lg:gap-16">
        <div>
          <Eyebrow>On the job</Eyebrow>
          <h2 className="text-3xl leading-[1.12] font-bold sm:text-4xl">
            And in the pocket of whoever is doing the work.
          </h2>
          <p className="text-text-2 mt-5 text-lg">
            iPhone and Android, working with no signal at all — in a basement, in a crawlspace, an
            hour out of town — and catching up the moment the bars come back.
          </p>
          <Button href="/app" variant="secondary" size="lg" className="mt-7">
            See the phone app
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3 sm:gap-5">
          {shots.map((shot, index) => (
            <div
              key={shot.src}
              className={`border-border-strong bg-card overflow-hidden rounded-[16px] border shadow-[var(--shadow-2)] ${
                index === 1 ? '' : 'mt-6'
              }`}
            >
              <Image
                src={shot.src}
                alt={shot.alt}
                width={1080}
                height={1920}
                sizes="(max-width: 640px) 30vw, (max-width: 1024px) 28vw, 15rem"
                className="h-auto w-full"
              />
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}

function PlansStrip() {
  return (
    <Section className="bg-card-2 border-border border-y">
      <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <SectionHeading sub="One price a month, every feature in the plan, and texts and calls billed for what you use.">
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
