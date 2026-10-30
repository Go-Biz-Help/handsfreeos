import Image from 'next/image';
import Link from 'next/link';
import { competitors } from '@/content/compare';
import { company, urls } from '@/content/site';
import { tradePages } from '@/content/trade-pages';
import { Container } from './ui';

const columns = [
  {
    title: 'Product',
    links: [
      { href: '/features', label: 'What it does' },
      { href: '/#how', label: 'How it works' },
      { href: '/pricing', label: 'Pricing' },
      { href: '/app', label: 'Phone app' },
      { href: '/blog', label: 'Blog' },
      { href: '/affiliates', label: 'Affiliates' },
      ...competitors.map((c) => ({ href: `/vs/${c.id}`, label: `vs ${c.name}` })),
    ],
  },
  {
    title: 'Made for',
    links: tradePages.map((p) => ({ href: `/${p.slug}`, label: p.who })),
  },
  {
    title: 'Help',
    links: [
      { href: '/support', label: 'Support' },
      { href: `mailto:${company.supportEmail}`, label: company.supportEmail },
      { href: urls.deleteAccount, label: 'Delete your account' },
      { href: urls.signIn, label: 'Sign in' },
    ],
  },
  {
    title: 'Legal',
    links: [
      { href: '/privacy', label: 'Privacy policy' },
      { href: '/terms', label: 'Terms of service' },
      { href: '/affiliates/terms', label: 'Affiliate terms' },
      { href: '/privacy#messaging', label: 'Texting and consent' },
      { href: '/privacy#google', label: 'Google user data' },
    ],
  },
];

export function SiteFooter() {
  const year = new Date().getFullYear();
  return (
    <footer className="border-border bg-card-2 border-t">
      <Container className="py-14">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-[minmax(0,1.5fr)_repeat(4,minmax(0,1fr))]">
          <div>
            <Link href="/" className="flex items-center gap-2.5 font-bold">
              <Image
                src="/handsfreeos-mark.png"
                alt="HandsFreeOS"
                width={28}
                height={28}
                className="rounded-md"
              />
              <span aria-hidden className="tracking-tight">
                HandsFreeOS
              </span>
            </Link>
            {/*
             * The owner's tagline, kept on every page since the home page's headline changed on
             * 28 October 2026. The line under it answers the puzzle.
             */}
            <p className="text-text mt-4 max-w-xs text-lg leading-snug font-semibold">
              The CRM that doesn&rsquo;t want you to use it.
            </p>
            <p className="text-text-2 mt-2 max-w-xs text-base">
              One place for the calls, texts, email, calendar and money of a small service business.
              It does the busywork on its own, so the less you use it, the better it&rsquo;s
              working.
            </p>
          </div>
          {columns.map((column) => (
            <div key={column.title}>
              <h3 className="text-text mb-4 text-sm font-semibold">{column.title}</h3>
              <ul className="space-y-2.5">
                {column.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-text-2 hover:text-text text-base [overflow-wrap:anywhere]"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-border text-text-3 mt-12 flex flex-col gap-2 border-t pt-8 text-sm sm:flex-row sm:items-center sm:justify-between">
          {/* Twilio's A2P review, Stripe and Square all check that the site names the legal company. */}
          <p>
            © {year} {company.legalName}. HandsFreeOS is a product of {company.legalName}.
          </p>
          <p>Made for the people who are out on the job, not at a desk.</p>
        </div>
      </Container>
    </footer>
  );
}
