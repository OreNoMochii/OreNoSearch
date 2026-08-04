import { useId, useState, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import styles from './InfoTooltip.module.css';

interface InfoTooltipProps {
  /** Accessible name for the trigger, e.g. "About the tree scorer". */
  label: string;
  children: ReactNode;
}

/**
 * Keyboard- and screen-reader-accessible tooltip.
 *
 * The six tooltips in App.tsx were driven purely by onMouseEnter/onMouseLeave
 * on a <div>, so their content was unreachable by keyboard and invisible to
 * assistive technology. This exposes the same content through a real button
 * with focus handlers and `aria-describedby`.
 *
 * WCAG: 2.1.1 (keyboard), 1.4.13 (dismissible on Escape), 4.1.2 (name/role).
 */
export function InfoTooltip({ label, children }: InfoTooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  return (
    <span className={styles.wrapper}>
      <button
        type="button"
        className={styles.trigger}
        aria-label={label}
        aria-describedby={open ? id : undefined}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) {
            e.stopPropagation(); // don't also close a surrounding dialog
            setOpen(false);
          }
        }}
      >
        <Info size={14} aria-hidden="true" />
      </button>

      {open ? (
        <span id={id} role="tooltip" className={styles.bubble}>
          {children}
        </span>
      ) : null}
    </span>
  );
}
