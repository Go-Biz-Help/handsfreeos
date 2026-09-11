export function OrDivider({ label = 'or with email' }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-[12.5px] text-text-3 before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      {label}
    </div>
  );
}
