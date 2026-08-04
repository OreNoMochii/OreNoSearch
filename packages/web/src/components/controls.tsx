import type {
    ButtonHTMLAttributes,
    InputHTMLAttributes,
    ReactNode,
    SelectHTMLAttributes,
    TextareaHTMLAttributes,
} from 'react';
import { useId } from 'react';
import styles from './controls.module.css';

/**
 * Form and action primitives.
 *
 * These replace 204 inline `style={{…}}` objects in App.tsx. Beyond the
 * duplication, inline styles cannot express `:focus-visible`, `:hover`,
 * `@media` or `prefers-reduced-motion`, so the previous UI had no focus
 * indicators and no responsive behaviour at all.
 */

// ── Text input ──────────────────────────────────────────────────────────────

export type TextInputProps = InputHTMLAttributes<HTMLInputElement>;

export function TextInput(props: TextInputProps) {
    return <input {...props} className={`${styles.control} ${props.className ?? ''}`} />;
}

// ── Textarea ────────────────────────────────────────────────────────────────

export type TextAreaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export function TextArea(props: TextAreaProps) {
    return (
        <textarea {...props} className={`${styles.control} ${styles.textarea} ${props.className ?? ''}`} />
    );
}

// ── Select ──────────────────────────────────────────────────────────────────

export type SelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export function Select(props: SelectProps) {
    return (
        <select {...props} className={`${styles.control} ${styles.select} ${props.className ?? ''}`}>
            {props.children}
        </select>
    );
}

// ── Checkbox ────────────────────────────────────────────────────────────────

interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
    label: ReactNode;
    help?: ReactNode;
}

/**
 * Checkbox with its label wired through htmlFor rather than wrapping, so the
 * accessible name is unambiguous even when the label contains markup.
 */
export function Checkbox({ label, help, ...props }: CheckboxProps) {
    const id = useId();
    const helpId = help ? `${id}-help` : undefined;

    return (
        <div className={styles.checkboxRow}>
            <input
                {...props}
                id={id}
                type="checkbox"
                className={styles.checkbox}
                aria-describedby={helpId}
            />
            <div className={styles.checkboxText}>
                <label htmlFor={id} className={styles.checkboxLabel}>
                    {label}
                </label>
                {help ? (
                    <p id={helpId} className={styles.checkboxHelp}>
                        {help}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

// ── Button ──────────────────────────────────────────────────────────────────

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    /** Renders a spinner and sets aria-busy. */
    loading?: boolean;
    icon?: ReactNode;
    fullWidth?: boolean;
}

export function Button({
    variant = 'secondary',
    loading = false,
    icon,
    fullWidth = false,
    children,
    className,
    disabled,
    // Every button carries an explicit type. Without it the default is
    // "submit", which fires the enclosing form — a latent bug now that the
    // outreach modal is a real <form>.
    type = 'button',
    ...props
}: ButtonProps) {
    return (
        <button
            {...props}
            type={type}
            disabled={disabled ?? loading}
            aria-busy={loading || undefined}
            className={[
                styles.button,
                styles[variant],
                fullWidth ? styles.fullWidth : '',
                className ?? '',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {loading ? <span className={styles.spinner} aria-hidden="true" /> : icon}
            {children}
        </button>
    );
}

// ── Chip ────────────────────────────────────────────────────────────────────

interface ChipProps {
    label: string;
    onRemove: () => void;
    /** Used to build the remove button's accessible name. */
    removeLabel?: string;
}

/** Removable filter token. The remove control is a real button. */
export function Chip({ label, onRemove, removeLabel }: ChipProps) {
    return (
        <span className={styles.chip}>
            <button
                type="button"
                className={styles.chipRemove}
                onClick={onRemove}
                aria-label={removeLabel ?? `Remove ${label}`}
            >
                <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path
                        d="M1 1l8 8M9 1l-8 8"
                        stroke="currentColor"
                        strokeWidth="1.75"
                        strokeLinecap="round"
                    />
                </svg>
            </button>
            {label}
        </span>
    );
}
