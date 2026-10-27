import type { Faq } from '@/content/faqs';
import { company, urls } from '@/content/site';
import { hasRoom, type FoundingSpot } from '@/lib/founding';

/**
 * Structured data, in JSON-LD.
 *
 * Search engines have read this for years; assistants now lean on it harder, because they pull
 * pieces of a page rather than the whole of it and this is what says which piece is what.
 *
 * Everything below describes something a reader can also see on the page. Nothing is invented for
 * the robots — in particular there is no `aggregateRating`, because there are no reviews yet, and a
 * made-up one is both a lie and a manual penalty waiting to happen.
 */

/**
 * One JSON-LD block. The blog's come from Opinly rather than from src/content, so `<` is escaped: a post title
 * containing `</script>` would otherwise end the block early and run whatever followed it as markup.
 */
export function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{
        __html: JSON.stringify(data)
          .replace(/</g, '\\u003c')
          .replace(/\u2028/g, '\\u2028')
          .replace(/\u2029/g, '\\u2029'),
      }}
    />
  );
}

/** Who publishes this site. Sits on the home page, which is the page everything else points at. */
export function OrganizationJsonLd() {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'Organization',
        '@id': `${urls.site}/#organization`,
        name: company.legalName,
        alternateName: company.product,
        url: urls.site,
        logo: `${urls.site}/handsfreeos-mark.png`,
        email: company.supportEmail,
        address: {
          '@type': 'PostalAddress',
          streetAddress: company.mailingAddress[0],
          addressLocality: 'Madison',
          addressRegion: 'AL',
          postalCode: '35758',
          addressCountry: 'US',
        },
        contactPoint: {
          '@type': 'ContactPoint',
          contactType: 'customer support',
          email: company.supportEmail,
          url: `${urls.site}/support`,
          availableLanguage: 'English',
        },
      }}
    />
  );
}

export function WebSiteJsonLd() {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'WebSite',
        '@id': `${urls.site}/#website`,
        url: urls.site,
        name: company.product,
        publisher: { '@id': `${urls.site}/#organization` },
        inLanguage: 'en-US',
      }}
    />
  );
}

/**
 * What the product is, and what it costs. The offer comes from the same file as the pricing page, and only while
 * the database has it on sale with room (`spots`): a price in a search result for something nobody can buy is an
 * ad for something that does not exist.
 */
export function SoftwareApplicationJsonLd({ spots }: { spots: readonly FoundingSpot[] }) {
  // The monthly spot, as the one Offer: the hundred yearly spots can sell out long before a search result forgets
  // them, and a thousand monthly ones last.
  const monthly = spots.find((s) => s.content.plan === 'monthly' && hasRoom(s)) ?? null;
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        '@id': `${urls.site}/#software`,
        name: company.product,
        applicationCategory: 'BusinessApplication',
        applicationSubCategory: 'Customer Relationship Management',
        operatingSystem: 'Web, iOS, Android',
        url: urls.site,
        publisher: { '@id': `${urls.site}/#organization` },
        description:
          'One place for the calls, texts, email, calendar, quotes and invoices of a small service business, with an AI teammate that answers new leads and books them in.',
        featureList: [
          'Business phone number with shared inbox for texts, calls and email',
          'AI teammate that answers leads by text, email and website chat',
          'Customers, leads and pipeline',
          'Online booking and appointment reminders',
          'Estimates, invoices, deposits and recurring plans',
          'Automatic follow-up workflows',
          'iPhone and Android app that works offline',
        ],
        ...(monthly
          ? {
              offers: {
                '@type': 'Offer',
                name: monthly.content.name,
                price: String(monthly.content.price),
                priceCurrency: 'USD',
                category: 'subscription',
                url: `${urls.site}/pricing`,
                availability: 'https://schema.org/InStock',
              },
            }
          : {}),
      }}
    />
  );
}

/** The questions on the page, in the form an assistant can lift an answer from. */
export function FaqJsonLd({ faqs, id }: { faqs: readonly Faq[]; id: string }) {
  return (
    <JsonLd
      data={{
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        '@id': id,
        mainEntity: faqs.map((faq) => ({
          '@type': 'Question',
          name: faq.q,
          acceptedAnswer: { '@type': 'Answer', text: faq.a },
        })),
      }}
    />
  );
}
