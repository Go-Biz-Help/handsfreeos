import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3 md:mb-6 md:gap-4">
      <div>
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em] md:text-2xl">
          {title}
        </h1>
        {description ? <p className="mt-1 text-text-2">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2 md:gap-3">{actions}</div> : null}
    </div>
  );
}
