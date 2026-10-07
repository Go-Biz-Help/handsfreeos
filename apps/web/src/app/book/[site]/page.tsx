import { ChevronRight, Globe } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { BusinessPage } from '@/components/booking/business-page';
import { BookingOff, PublicState } from '@/components/booking/public-shell';
import { getSite, pageData } from '@/lib/api/public-booking';
import { requestOrigin } from '@/lib/hosting/request-origin';

type Props = { params: Promise<{ site: string }> };

/** The site, with its simple page's chat for the address it's shown at. */
const siteData = async (site: string) => pageData(getSite(site, await requestOrigin()));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { site } = await params;
  const data = await siteData(site);
  if (data.page)
    return {
      title: { absolute: data.business.name },
      ...(data.page.description
        ? { description: data.page.description.replace(/\s+/g, ' ').slice(0, 160) }
        : {}),
    };
  return { title: { absolute: `Book online · ${data.business.name}` } };
}

/** The business's public calendars, or its simple page when it has one on. */
export default async function BookingSitePage({ params }: Props) {
  const { site } = await params;
  const data = await siteData(site);
  if (data.page)
    return (
      <main className="mx-auto flex w-full max-w-[640px] flex-1 flex-col px-4 py-6 md:py-10">
        <BusinessPage
          business={data.business}
          page={data.page}
          site={data.site}
          calendars={data.calendars}
        />
        {/* The business's website chat, set up for this address: its loader, served here as on any site. */}
        {data.page.chat ? <script async src={`/embed/v1/${data.page.chat}.js`} /> : null}
      </main>
    );
  if (!data.site.enabled) return <BookingOff business={data.business} />;
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col gap-4 px-4 py-6 md:py-10">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Book with {data.business.name}</h1>
        {data.site.intro ? (
          <p className="whitespace-pre-line text-[13px] text-text-2">{data.site.intro}</p>
        ) : (
          <p className="text-[13px] text-text-2">Pick what you’d like to book.</p>
        )}
      </div>
      {data.calendars.length ? (
        <ul className="flex flex-col gap-2">
          {data.calendars.map((c) => (
            <li key={c.slug}>
              <Link
                href={`/book/${data.site.slug}/${c.slug}`}
                className="flex min-h-[60px] items-center gap-3 rounded-[10px] border border-border-strong bg-card px-3.5 py-3 transition-colors hover:border-accent hover:bg-card-2"
              >
                <span className="flex min-w-0 flex-1 flex-col gap-px">
                  <span className="text-[15px] font-medium">{c.name}</span>
                  {c.description ? (
                    <span className="text-xs text-text-2">{c.description}</span>
                  ) : null}
                </span>
                <ChevronRight size={18} className="flex-none text-text-3" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <PublicState icon={<Globe size={20} />} title="Nothing to book online right now">
          Check back soon, or contact {data.business.name}.
        </PublicState>
      )}
      <p className="flex items-center gap-1.5 text-xs text-text-3">
        <Globe size={14} aria-hidden />
        Times in {data.timezoneLabel}
      </p>
    </main>
  );
}
