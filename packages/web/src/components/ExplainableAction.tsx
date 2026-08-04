import { useId, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import styles from './ExplainableAction.module.css';

type Tone = 'search' | 'ml' | 'ai' | 'tree' | 'hybrid' | 'neutral';

interface ExplainableActionProps {
  label: ReactNode;
  /** Explanation shown on hover AND on keyboard focus. */
  explanation: ReactNode;
  onClick: () => void;
  icon?: ReactNode;
  tone?: Tone;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
}

/**
 * An action button with an attached explanation.
 *
 * Replaces six near-identical blocks in App.tsx (~45 lines each) where the
 * tooltip was driven by onMouseEnter/onMouseLeave on a wrapping <div>. Three
 * problems with that:
 *
 *   1. Hover-only. A keyboard user tabbing to the button never saw the
 *      explanation — WCAG 2.1.1.
 *   2. No programmatic association. The tooltip was an unrelated sibling node,
 *      so a screen reader announced the button with no description — WCAG 4.1.2.
 *   3. Not dismissible. WCAG 1.4.13 requires hoverable content be dismissible
 *      without moving the pointer.
 *
 * React's onFocus/onBlur bubble (unlike native focus/blur), so attaching them
 * to the wrapper covers focus landing anywhere inside it.
 */
export function ExplainableAction({
  label,
  explanation,
  onClick,
  icon,
  tone = 'neutral',
  disabled = false,
  loading = false,
  fullWidth = true,
}: ExplainableActionProps) {
  const tipId = useId();
  const [open, setOpen] = useState(false);

  return (
    <div
      className={`${styles.wrapper} ${fullWidth ? styles.fullWidth : ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || loading}
        aria-describedby={tipId}
        aria-busy={loading || undefined}
        className={`${styles.button} ${styles[tone]}`}
      >
        {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
        <span className={styles.label}>{label}</span>
        <span className={styles.badge}>
          <Info size={12} aria-hidden="true" />
          Explain
        </span>
      </button>

      {/* Always rendered so aria-describedby resolves even while hidden;
                visibility is CSS-driven rather than conditional mounting. */}
      <span
        id={tipId}
        role="tooltip"
        className={`${styles.tooltip} ${open ? styles.tooltipVisible : ''}`}
      >
        {explanation}
      </span>
    </div>
  );
}
