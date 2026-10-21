import type { Metadata } from 'next';
import Image from 'next/image';
import { Button, Card, Container, Eyebrow, Section, SectionHeading } from '@/components/ui';
import { urls } from '@/content/site';

export const metadata: Metadata = {
  title: 'iPhone and Android app that works offline',
  description:
    'Customers, jobs, photos, calendar and invoices on iPhone and Android — all working with no signal, syncing when you are back, with calls through your own phone.',
  alternates: { canonical: '/app' },
};

const shots = [
  {
    src: '/screenshots/home.png',
    alt: 'The Home screen of the HandsFreeOS app, showing what needs attention with the money affected at the top.',
    caption: 'What needs you, money first',
  },
  {
    src: '/screenshots/offline-queue.png',
    alt: 'The HandsFreeOS app showing changes made with no signal, waiting to send.',
    caption: 'Changes made with no signal',
  },
  {
    src: '/screenshots/calendar.png',
    alt: 'The calendar in the HandsFreeOS app, showing a day of appointments.',
    caption: 'The day, as it stands',
  },
  {
    src: '/screenshots/invoice.png',
    alt: 'An invoice in the HandsFreeOS app, ready to send to a customer.',
    caption: 'Invoice from the driveway',
  },
];

export default function AppPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <div className="grid items-center gap-12 lg:grid-cols-[1fr_1fr]">
          <div>
            <Eyebrow>iPhone and Android</Eyebrow>
            <h1 className="text-[2.25rem] leading-[1.08] font-bold sm:text-5xl">
              It stays in your pocket until something needs you.
            </h1>
            <p className="text-text-2 mt-6 text-lg">
              HandsFreeOS answers, books and chases on its own, and taps you on the shoulder when it
              is your turn. Then the whole business is right there — and not as a website in a
              wrapper. Everything can be read and changed with no signal at all, in a basement, in a
              crawlspace, an hour out of town, and catches up the moment you have bars again.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button href={urls.signUp} size="lg">
                Start free
              </Button>
              <Button href="/pricing" size="lg" variant="secondary">
                See pricing
              </Button>
            </div>
            {/* A store gets a link once its address is in site.ts. */}
            <p className="text-text-3 mt-5 text-sm">
              {urls.playStore ? (
                <>
                  Android:{' '}
                  <a
                    href={urls.playStore}
                    className="text-accent-text font-semibold hover:underline"
                  >
                    get it on Google Play
                  </a>
                  .{' '}
                </>
              ) : (
                'Android: coming to Google Play. '
              )}
              {urls.appStore ? (
                <>
                  iPhone:{' '}
                  <a
                    href={urls.appStore}
                    className="text-accent-text font-semibold hover:underline"
                  >
                    get it on the App Store
                  </a>
                  .
                </>
              ) : (
                'iPhone: coming to the App Store. The web app works on your phone in the meantime.'
              )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 sm:gap-6">
            {shots.slice(0, 2).map((shot) => (
              <Shot key={shot.src} {...shot} priority />
            ))}
          </div>
        </div>
      </Container>

      <Section className="bg-card-2 border-border border-y">
        <SectionHeading sub="The things that are different when the person using it is standing in someone's yard.">
          Built for a working day, not a desk.
        </SectionHeading>

        <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: 'It works with no signal',
              body: 'Look up a customer, write a note, take photos, move a job, start an invoice. Nothing is greyed out. When the signal comes back it all syncs, and if two of you changed the same job, both changes are kept unless they are the very same field.',
            },
            {
              title: 'A text you wrote offline will not surprise a customer',
              body: 'Messages written with no signal send themselves if they get out within half an hour. After that the app asks "still send?" rather than firing off something that has gone stale.',
            },
            {
              title: 'Calls ring your actual phone',
              body: 'Calling a customer from the app dials through your own cell but shows your business number, so your personal number stays private and the call quality is your carrier, not the internet.',
            },
            {
              title: 'Most of it without opening the app',
              body: 'A new lead comes through as a notification you can reply to, call back or hand to the AI without opening the app first. Plenty of days, that is as far in as you need to go.',
            },
            {
              title: 'Face ID and a code by email',
              body: 'Sign in with a code sent to your email, a password or a passkey, then unlock with your face. Nothing to remember on a job site.',
            },
            {
              title: 'Photos where they belong',
              body: 'Pictures of the unit, the panel, the damage — attached to the customer and the job, not lost in a camera roll with 4,000 other photos.',
            },
          ].map((item) => (
            <Card key={item.title} className="h-full">
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-text-2 mt-2.5">{item.body}</p>
            </Card>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHeading>A look around</SectionHeading>
        <div className="mt-10 grid grid-cols-2 gap-6 lg:grid-cols-4">
          {shots.map((shot) => (
            <Shot key={shot.src} {...shot} />
          ))}
        </div>
        <p className="text-text-3 mt-6 text-sm">
          Screens from the app, filled with a made-up demo business.
        </p>
      </Section>

      <Section className="bg-card-2 border-border border-t">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-bold">Your crew will reach for it when it counts.</h2>
          <p className="text-text-2 mt-5 text-lg">
            Because it is faster than texting you to ask, it works where their signal does not, and
            the rest of the time it stays out of their way.
          </p>
          <div className="mt-8 flex justify-center">
            <Button href={urls.signUp} size="lg">
              Start free
            </Button>
          </div>
        </div>
      </Section>
    </>
  );
}

function Shot({
  src,
  alt,
  caption,
  priority = false,
}: {
  src: string;
  alt: string;
  caption: string;
  priority?: boolean;
}) {
  return (
    <figure className="m-0">
      <div className="border-border-strong bg-card overflow-hidden rounded-[18px] border shadow-[var(--shadow-2)]">
        <Image
          src={src}
          alt={alt}
          width={1080}
          height={1920}
          priority={priority}
          sizes="(max-width: 640px) 45vw, (max-width: 1024px) 40vw, 22vw"
          className="h-auto w-full"
        />
      </div>
      <figcaption className="text-text-3 mt-3 text-sm">{caption}</figcaption>
    </figure>
  );
}
