'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { urls } from '@/content/site';
import { Button, Container } from './ui';

const links = [
  { href: '/features', label: 'What it does' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/app', label: 'Phone app' },
  { href: '/blog', label: 'Blog' },
  { href: '/support', label: 'Support' },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const here = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  // A menu that stays open on the next page, or ignores Escape, is a menu somebody has to fight.
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    // `site-header` lets it lie flat on the page at the top and settle into a bar once scrolled (globals.css).
    <header className="site-header border-border bg-bg/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-bold"
          onClick={() => setOpen(false)}
        >
          {/* The picture carries the name; the word is hidden from screen readers so it is read once. */}
          <Image
            src="/handsfreeos-mark.png"
            alt="HandsFreeOS"
            width={28}
            height={28}
            className="rounded-md"
          />
          <span aria-hidden className="text-[1.0625rem] tracking-tight">
            HandsFreeOS
          </span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Main">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={here(link.href) ? 'page' : undefined}
              className={`rounded-[8px] px-3 py-1.5 text-[0.9375rem] transition-colors duration-150 ${
                here(link.href) ? 'text-text font-medium' : 'text-text-2 hover:text-text'
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          <Link
            href={urls.signIn}
            className="text-text-2 hover:text-text rounded-[8px] px-3 py-1.5 text-[0.9375rem] transition-colors duration-150"
          >
            Sign in
          </Link>
          <Button href={urls.signUp}>Sign up</Button>
        </div>

        <button
          type="button"
          className="border-border-strong text-text -mr-1 flex h-10 w-10 items-center justify-center rounded-[10px] border transition-transform duration-[160ms] ease-out motion-safe:active:scale-[0.95] md:hidden"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          {/* Three lines that fold into a cross and back, so the button shows what pressing it again does. */}
          <span aria-hidden="true" className="relative block h-3.5 w-[18px]">
            {[0, 1, 2].map((line) => (
              <span
                key={line}
                className={`bg-current absolute left-0 h-[1.75px] w-full rounded-full transition-[transform,opacity] duration-200 ease-in-out ${
                  line === 0 ? 'top-0' : line === 1 ? 'top-1/2 -mt-px' : 'bottom-0'
                } ${
                  open
                    ? line === 0
                      ? 'translate-y-[6px] rotate-45'
                      : line === 1
                        ? 'opacity-0'
                        : '-translate-y-[6px] -rotate-45'
                    : ''
                }`}
              />
            ))}
          </span>
        </button>
      </Container>

      {open ? (
        // Drops in from just under the bar (it hangs from it, so it comes from above), and leaves at once.
        <div
          id="site-menu"
          className="border-border bg-bg origin-top border-t transition-[opacity,transform] duration-200 ease-out md:hidden starting:-translate-y-1.5 starting:opacity-0"
        >
          <Container className="flex flex-col gap-1 py-4">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={here(link.href) ? 'page' : undefined}
                className={`py-2.5 text-base ${here(link.href) ? 'text-accent-text font-semibold' : 'text-text'}`}
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <Link href={urls.signIn} className="text-text py-2.5 text-base">
              Sign in
            </Link>
            <Button href={urls.signUp} className="mt-2" size="lg">
              Sign up
            </Button>
          </Container>
        </div>
      ) : null}
    </header>
  );
}
