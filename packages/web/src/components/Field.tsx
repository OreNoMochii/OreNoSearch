import { useId, type ReactNode } from 'react';
import styles from './Field.module.css';

interface FieldProps {
    label: string;
    /** Renders the required marker and forwards `required` to the control. */
    required?: boolean;
    /** Help text rendered below the control and wired via aria-describedby. */
    help?: ReactNode;
    /** Validation message. Announced assertively when present. */
    error?: string;
    /**
     * Receives the ids the control must carry. Every control in this app is
     * rendered through here, which is what guarantees the label association
     * that 21 of 24 inputs previously lacked.
     */
    children: (props: {
        id: string;
        required: boolean;
        'aria-describedby': string | undefined;
        'aria-invalid': boolean | undefined;
    }) => ReactNode;
}

/**
 * Labelled form control wrapper.
 *
 * The original markup used bare `<label>` elements with no `htmlFor`, sitting
 * as siblings of unlabelled inputs. That reads as a visual caption but conveys
 * nothing to assistive technology, and clicking the label does not focus the
 * control. Generating the id here makes the association impossible to forget.
 *
 * WCAG: 1.3.1 (info and relationships), 3.3.2 (labels or instructions).
 */
export function Field({ label, required = false, help, error, children }: FieldProps) {
    const id = useId();
    const helpId = help ? `${id}-help` : undefined;
    const errorId = error ? `${id}-error` : undefined;
    const describedBy = [helpId, errorId].filter(Boolean).join(' ') || undefined;

    return (
        <div className={styles.field}>
            <label htmlFor={id} className={styles.label}>
                {label}
                {required ? (
                    <>
                        <span aria-hidden="true" className={styles.marker}>
                            *
                        </span>
                        <span className="sr-only">(required)</span>
                    </>
                ) : null}
            </label>

            {children({
                id,
                required,
                'aria-describedby': describedBy,
                'aria-invalid': error ? true : undefined,
            })}

            {help ? (
                <p id={helpId} className={styles.help}>
                    {help}
                </p>
            ) : null}

            {error ? (
                <p id={errorId} role="alert" className={styles.error}>
                    {error}
                </p>
            ) : null}
        </div>
    );
}
