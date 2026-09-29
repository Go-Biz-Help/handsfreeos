import type { ReactNode } from 'react';

/**
 * A page's title, what it is for, and its main actions. A section is the same inside a page that already has its
 * title, as a settings page does beside the settings menu.
 */
export function PageHeader({
  title,
  description,
  actions,
  section = false,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  section?: boolean;
}) {
  const Heading = section ? 'h2' : 'h1';
  return (
    <div
      className={
        section
          ? 'mb-4 flex flex-wrap items-start justify-between gap-3'
          : 'mb-5 flex flex-wrap items-start justify-between gap-3 md:mb-6 md:gap-4'
      }
    >
      <div>
        <Heading
          className={
            section
              ? 'text-lg font-semibold tracking-tight'
              : 'text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl'
          }
        >
          {title}
        </Heading>
        {description ? (
          <p className={section ? 'mt-0.5 text-[13px] text-text-2' : 'mt-1 text-text-2'}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 md:gap-3">{actions}</div> : null}
    </div>
  );
}
