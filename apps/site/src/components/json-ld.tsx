import type { Faq } from '@/content/faqs';
import { company, plan, urls } from '@/content/site';

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

function Script({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // The content is ours, built from the files in src/content, never from user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

/** Who publishes this site. Sits on the home page, which is the page everything else points at. */
export function OrganizationJsonLd() {
  return (
    <Script
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
    <Script
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

/** What the product is, and what it costs. The offers come from the same file as the pricing page. */
export function SoftwareApplicationJsonLd() {
  return (
    <Script
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
        // One plan, so one Offer. The founding seats are deliberately not listed: a capped offer that sells
        // out would leave a search result advertising something nobody can buy, for as long as Google
        // remembers it.
        offers: {
          '@type': 'Offer',
          name: plan.name,
          price: String(plan.price),
          priceCurrency: 'USD',
          category: 'subscription',
          url: `${urls.site}/pricing`,
          availability: 'https://schema.org/InStock',
        },
      }}
    />
  );
}

/** The questions on the page, in the form an assistant can lift an answer from. */
export function FaqJsonLd({ faqs, id }: { faqs: readonly Faq[]; id: string }) {
  return (
    <Script
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
