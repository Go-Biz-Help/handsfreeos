import type { Metadata } from 'next';
import Link from 'next/link';
import { Button, Card, Container, Section, SectionHeading } from '@/components/ui';
import { company, urls } from '@/content/site';

export const metadata: Metadata = {
  title: 'Support and help',
  description:
    'Get help with HandsFreeOS: how to reach a person, what to tell us so it is fixed faster, and how to delete an account, export your data or fix texts not arriving.',
  alternates: { canonical: '/support' },
};

export default function SupportPage() {
  return (
    <>
      <Container className="py-16 sm:py-20">
        <SectionHeading
          sub="A real person reads these. Email is the fastest way in, whether you use HandsFreeOS on the web or on your phone."
          as="h1"
        >
          Something not working? Tell us.
        </SectionHeading>

        <div className="mt-10 grid gap-6 md:grid-cols-2">
          <Card>
            <h2 className="text-lg font-semibold">Email us</h2>
            <p className="text-text-2 mt-2.5">
              <a
                className="text-accent-text font-semibold underline underline-offset-2"
                href={`mailto:${company.supportEmail}`}
              >
                {company.supportEmail}
              </a>
              <br />
              You get a ticket number back straight away, and replying to that email adds to the
              same ticket. We answer Monday to Friday, and we aim to come back to you the same
              working day. Anything where customers cannot be reached — texts not sending, calls not
              ringing through — jumps the queue.
            </p>
          </Card>
          <Card>
            <h2 className="text-lg font-semibold">Ask inside HandsFreeOS</h2>
            <p className="text-text-2 mt-2.5">
              The Assistant panel (the button on every screen, or ⌘J on a keyboard) answers most
              &ldquo;how do I&rdquo; questions on the spot, and it can make the change for you once
              you say yes. When you need a person instead, <strong>Get help</strong> at the bottom
              of the menu opens a ticket with your business and the screen you were on already
              attached.
            </p>
            <Button href={urls.signIn} variant="secondary" className="mt-4">
              Sign in
            </Button>
          </Card>
        </div>
      </Container>

      <Section className="bg-card-2 border-border border-y">
        <SectionHeading>What to tell us, so we can fix it faster</SectionHeading>
        <ul className="text-text-2 mt-8 grid max-w-3xl gap-3 text-lg">
          {[
            'The name of your business in HandsFreeOS.',
            'What you were doing, and what you expected to happen instead.',
            'Roughly when it happened, and whether it is still happening.',
            'Whether it was on the web or the phone app, and which phone.',
            'A screenshot, if you have one.',
          ].map((item) => (
            <li key={item} className="flex gap-3">
              <span className="text-accent-text font-bold">→</span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <p className="text-text-3 mt-6 max-w-3xl">
          Please do not send us passwords, card numbers or anything a customer told you in
          confidence. We never need them, and we will not ask.
        </p>
      </Section>

      <Section>
        <SectionHeading>The things people ask for most</SectionHeading>
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          {[
            {
              title: 'Delete my account',
              body: (
                <>
                  You can do it yourself, without asking us, at{' '}
                  <Link
                    className="text-accent-text underline underline-offset-2"
                    href={urls.deleteAccount}
                  >
                    app.handsfreeos.com/delete-account
                  </Link>
                  , or in the app under Settings → Account. The page explains what happens to the
                  businesses you belong to.
                </>
              ),
            },
            {
              title: 'Get my data out',
              body: (
                <>
                  Your customers, conversations, appointments and money records export from
                  Settings, in files a spreadsheet can open. Ask us if you want the whole thing at
                  once.
                </>
              ),
            },
            {
              title: 'My texts are not arriving',
              body: (
                <>
                  Nine times out of ten this is carrier registration, which every business texting
                  number in the US has to have. Email us and we will tell you exactly where yours is
                  stuck.
                </>
              ),
            },
            {
              title: 'Stop the AI answering for now',
              body: (
                <>
                  Open AI teammate in the side menu and set its Status to Training wheels. It then
                  drafts every message and waits for a person, including for the kinds of reply it
                  had earned.
                </>
              ),
            },
            {
              title: 'Report something the AI got wrong',
              body: (
                <>
                  Send us the conversation. We take these seriously: it is how the wording, the
                  knowledge base and the limits get fixed for everyone.
                </>
              ),
            },
            {
              title: 'Billing and plans',
              body: (
                <>
                  Email us and we will sort it out the same day, including moving you down a plan if
                  you are paying for something you are not using.
                </>
              ),
            },
          ].map((item) => (
            <div key={item.title}>
              <h3 className="text-lg font-semibold">{item.title}</h3>
              <p className="text-text-2 mt-2.5">{item.body}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section className="bg-card-2 border-border border-t">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-2xl font-bold">Still stuck?</h2>
          <p className="text-text-2 mt-4 text-lg">
            Write to us at{' '}
            <a
              className="text-accent-text font-semibold underline underline-offset-2"
              href={`mailto:${company.supportEmail}`}
            >
              {company.supportEmail}
            </a>
            . {company.legalName} runs HandsFreeOS, and the same people who build it answer the
            email.
          </p>
        </div>
      </Section>
    </>
  );
}
