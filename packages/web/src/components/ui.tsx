import type { ReactNode, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react';

/**
 * ui.tsx — the shared vocabulary every panel is built from.
 *
 * Before this, each section invented its own label size, gap and input
 * treatment, so the three panels drifted: one used 11px labels with a 4px gap,
 * another 11px with 6px, a third had no label at all. Nothing looked wrong in
 * isolation and the whole read as untidy.
 *
 * These are deliberately small and unclever. The point is not abstraction, it
 * is that there is exactly ONE way to render a labelled field, and every
 * section uses it.
 */

/* ── Section: a titled block within a panel ─────────────────────────────── */

export function Section({
  title,
  action,
  children,
}: {
  title?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex w-full flex-col gap-3">
      {(title || action) && (
        <div className="flex min-h-[18px] items-center justify-between gap-2">
          {title && <SectionLabel>{title}</SectionLabel>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

/** The one uppercase label treatment. Used for every section heading. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-[1.2px] text-ink-3">{children}</h2>
  );
}

/* ── Field: label + control + optional hint ─────────────────────────────── */

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-[11px] font-medium text-ink-2">
        {label}
      </label>
      {children}
      {hint && <span className="text-[10.5px] leading-snug text-ink-3">{hint}</span>}
    </div>
  );
}

/* ── Controls ───────────────────────────────────────────────────────────── */

const CONTROL =
  'w-full rounded-[6px] bg-input px-3 py-2.5 text-[13px] text-ink outline-none ' +
  'border border-transparent transition-colors hover:bg-input-hover ' +
  'focus:border-accent-line focus:bg-input';

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`${CONTROL} ${className}`} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = '', ...rest } = props;
  return <textarea {...rest} className={`${CONTROL} resize-y ${className}`} />;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const { className = '', children, ...rest } = props;
  return (
    <select {...rest} className={`${CONTROL} cursor-pointer appearance-none ${className}`}>
      {children}
    </select>
  );
}

/** Monospace variant — query text is code and reads better as such. */
export function CodeInput(props: InputHTMLAttributes<HTMLInputElement>) {
  const { className = '', ...rest } = props;
  return <input {...rest} className={`${CONTROL} font-mono text-[12px] ${className}`} />;
}

/* ── Buttons ────────────────────────────────────────────────────────────── */

type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'danger';

const TONES: Record<ButtonTone, string> = {
  // Dark ink on sand: white would sit near 2:1 and fail outright.
  primary: 'bg-accent text-on-accent hover:bg-accent-hover font-semibold',
  secondary: 'bg-input text-ink-2 hover:bg-input-hover hover:text-ink font-medium',
  ghost: 'bg-transparent text-ink-2 hover:bg-input hover:text-ink font-medium',
  danger: 'bg-transparent text-danger hover:bg-danger-soft font-medium',
};

export function Button({
  tone = 'secondary',
  full,
  className = '',
  children,
  ...rest
}: {
  tone?: ButtonTone;
  full?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[6px] px-4 py-2.5 text-[12px]
        transition-colors cursor-pointer border-none disabled:cursor-not-allowed disabled:opacity-50
        ${TONES[tone]} ${full ? 'w-full' : ''} ${className}`}
    >
      {children}
    </button>
  );
}

/* ── Chip: removable filter tag ─────────────────────────────────────────── */

export function Chip({
  children,
  onRemove,
  removeLabel,
  tone = 'accent',
}: {
  children: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  tone?: 'accent' | 'neutral';
}) {
  const skin =
    tone === 'accent'
      ? 'bg-accent-soft text-accent'
      : 'bg-input text-ink-2 hover:text-ink';

  const content = (
    <>
      <span className="truncate">{children}</span>
      {onRemove && <span aria-hidden="true" className="shrink-0 opacity-60">×</span>}
    </>
  );

  if (!onRemove) {
    return (
      <span className={`inline-flex max-w-[240px] items-center gap-1.5 rounded-[4px] px-2.5 py-1.5 text-[11px] font-medium ${skin}`}>
        {content}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={onRemove}
      aria-label={removeLabel}
      className={`inline-flex max-w-[240px] cursor-pointer items-center gap-1.5 rounded-[4px] border-none px-2.5 py-1.5 text-[11px] font-medium transition-colors hover:brightness-110 ${skin}`}
    >
      {content}
    </button>
  );
}

/* ── Checkbox: label and control as one target ──────────────────────────── */

export function Checkbox({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label className="group flex w-full cursor-pointer items-start gap-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[1px] h-4 w-4 shrink-0 cursor-pointer rounded-[3px] accent-[var(--c-accent)]"
      />
      <span className="flex-1 text-[12px] leading-snug text-ink-2 group-hover:text-ink">
        {children}
      </span>
    </label>
  );
}

/* ── Slider with a live value readout ───────────────────────────────────── */

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-2">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-accent">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        className="w-full cursor-pointer accent-[var(--c-accent)]"
      />
    </div>
  );
}

/** Hairline divider between sections. */
export function Divider() {
  return <hr className="h-px w-full shrink-0 border-none bg-line" />;
}
