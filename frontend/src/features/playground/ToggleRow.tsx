/**
 * Labeled checkbox row used for the boolean toggles below the form
 * (native_only, show timestamps, etc). Pure presentational.
 */
export function ToggleRow({
  icon,
  title,
  subtitle,
  checked,
  onChange,
}: {
  icon: string;
  title: string;
  subtitle: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between border rounded-md px-3 py-2.5 cursor-pointer hover:bg-accent/30 transition-colors">
      <div className="flex items-center gap-3">
        <span className="text-lg" aria-hidden>
          {icon}
        </span>
        <div>
          <div className="text-sm font-medium">{title}</div>
          <div className="text-xs text-muted-foreground">{subtitle}</div>
        </div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 cursor-pointer"
      />
    </label>
  );
}
