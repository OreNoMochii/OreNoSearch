import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import styles from './Modal.module.css';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** id of the element labelling the dialog; must match the heading. */
  titleId: string;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * Accessible modal built on the native <dialog> element.
 *
 * The outreach modal was previously a bare <div> with `position: fixed`. It had
 * no role, no aria-modal, no focus trap, no Escape handling and no focus
 * restoration — a keyboard user could tab straight out of it into the page
 * behind, and a screen reader announced nothing. `showModal()` supplies all of
 * those behaviours natively, which is both less code and more correct than a
 * hand-rolled trap.
 *
 * WCAG: 2.1.2 (no keyboard trap), 2.4.3 (focus order), 4.1.2 (name/role/value).
 */
export function Modal({ open, onClose, titleId, title, children, footer }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // <dialog> fires `cancel` on Escape. Forward it so React state stays in
  // sync with the element's own open/closed state.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [onClose]);

  return (
    <dialog
      ref={ref}
      className={styles.dialog}
      aria-labelledby={titleId}
      // The dialog element itself is the backdrop region, so a click that
      // lands on it (rather than on .panel) is a backdrop dismiss.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className={styles.panel}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={styles.close}
            aria-label="Close dialog"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className={styles.body}>{children}</div>

        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </dialog>
  );
}
