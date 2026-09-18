'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { urls } from '@/content/site';
import { Button, Container } from './ui';

const links = [
  { href: '/#how', label: 'How it works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/app', label: 'Phone app' },
  { href: '/support', label: 'Support' },
];

export function SiteHeader() {
  const [open, setOpen] = useState(false);
  return (
    <header className="border-border bg-bg/85 sticky top-0 z-50 border-b backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-bold"
          onClick={() => setOpen(false)}
        >
          <Image src="/handsfreeos-mark.png" alt="" width={28} height={28} className="rounded-md" />
          <span className="text-[1.0625rem] tracking-tight">HandsFreeOS</span>
        </Link>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Main">
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-text-2 hover:text-text text-base transition-colors"
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <Link href={urls.signIn} className="text-text-2 hover:text-text text-base">
            Sign in
          </Link>
          <Button href={urls.signUp}>Start free</Button>
        </div>

        <button
          type="button"
          className="border-border-strong text-text -mr-1 rounded-[10px] border p-2 md:hidden"
          aria-expanded={open}
          aria-controls="site-menu"
          aria-label={open ? 'Close menu' : 'Open menu'}
          onClick={() => setOpen((value) => !value)}
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
        </button>
      </Container>

      {open ? (
        <div id="site-menu" className="border-border bg-bg border-t md:hidden">
          <Container className="flex flex-col gap-1 py-4">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-text py-2.5 text-base"
                onClick={() => setOpen(false)}
              >
                {link.label}
              </Link>
            ))}
            <Link href={urls.signIn} className="text-text py-2.5 text-base">
              Sign in
            </Link>
            <Button href={urls.signUp} className="mt-2" size="lg">
              Start free
            </Button>
          </Container>
        </div>
      ) : null}
    </header>
  );
}
