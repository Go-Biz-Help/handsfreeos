/**
 * The bottom of a customer's page (design tools, part 7; HANDSFREEOS_DESIGN_TOOLS_IMPLEMENTATION_PLAN.md, decision
 * 10): the business's license number, address, phone, website and social links, from the brand kit and Settings →
 * Payments. On their invoice, estimate, payment plan, document to sign and appointment, and on the printed copy too,
 * since contractors need the license on paperwork. Nothing shows when the business has none of these.
 */
import { footerHasAny, LOOK_SOCIAL_NAMES, websiteShown, type CustomerFooter } from '@hfos/core';
import { cn } from '@/lib/utils';

export function BusinessFooter({
  name,
  footer,
  className,
}: {
  name: string;
  footer: CustomerFooter | null | undefined;
  className?: string;
}) {
  if (!footerHasAny(footer)) return null;
  const reach = [
    footer.phone ? (
      <a
        key="phone"
        href={`tel:${footer.phone.replace(/[^\d+]/g, '')}`}
        className="hover:text-text"
      >
        {footer.phone}
      </a>
    ) : null,
    footer.website ? (
      <a
        key="website"
        href={footer.website}
        target="_blank"
        rel="noreferrer"
        className="hover:text-text"
      >
        {websiteShown(footer.website)}
      </a>
    ) : null,
  ].filter(Boolean);
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[560px] flex-col items-center gap-1 px-4 text-center text-[12px] leading-[1.5] text-text-3',
        className,
      )}
      data-testid="business-footer"
    >
      <p>
        <span className="font-medium text-text-2">{name}</span>
        {footer.license ? (
          <>
            {' · '}
            <span data-testid="business-footer-license">{footer.license}</span>
          </>
        ) : null}
      </p>
      {footer.address.length ? (
        <p data-testid="business-footer-address">{footer.address.join(', ')}</p>
      ) : null}
      {reach.length ? (
        <p className="flex flex-wrap items-center justify-center gap-x-2">
          {reach.map((r, i) => (
            <span key={i} className="flex items-center gap-x-2">
              {i ? <span aria-hidden>·</span> : null}
              {r}
            </span>
          ))}
        </p>
      ) : null}
      {footer.socials.length ? (
        <p className="flex flex-wrap items-center justify-center gap-x-3" data-print="hide">
          {footer.socials.map((s) => (
            <a
              key={s.url}
              href={s.url}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:text-text hover:underline"
            >
              {LOOK_SOCIAL_NAMES[s.kind]}
            </a>
          ))}
        </p>
      ) : null}
    </div>
  );
}
