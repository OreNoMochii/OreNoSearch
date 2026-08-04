import { useId, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import styles from './OutreachForm.module.css';

interface OutreachFormProps {
  jobName: string;
  setJobName: (val: string) => void;
  companyName: string;
  setCompanyName: (val: string) => void;
  adjacentRoles: string;
  setAdjacentRoles: (val: string) => void;
  outreachEmail: string;
  setOutreachEmail: (val: string) => void;
  outreachJd: string;
  setOutreachJd: (val: string) => void;
  isSubmitting: boolean;
  status: string | null;
  onSubmit: () => void;
  onCancel: () => void;
  showAdjacentRoles: boolean;
  children?: ReactNode; // For the ML settings injects
}

export function OutreachForm({
  jobName,
  setJobName,
  companyName,
  setCompanyName,
  adjacentRoles,
  setAdjacentRoles,
  outreachEmail,
  setOutreachEmail,
  outreachJd,
  setOutreachJd,
  isSubmitting,
  status,
  onSubmit,
  onCancel,
  showAdjacentRoles,
  children,
}: OutreachFormProps) {
  const errorId = useId();

  return (
    <form
      noValidate                      // we render our own messages, but keep native validation rules active
      onSubmit={(e) => { e.preventDefault(); onSubmit(); }}   // …native Enter-to-submit
      aria-busy={isSubmitting}
      className={styles.form}
    >
      <div className={styles.scrollArea}>
        <fieldset disabled={isSubmitting} className={styles.fieldset}>
          <legend className={styles.legend}>Campaign details</legend>

          {children}

          <div className={styles.field}>
            <label htmlFor="job-name">
              Job title <span aria-hidden="true">*</span>
              <span className={styles.srOnly}>(required)</span>
            </label>
            <input
              id="job-name" name="jobName" type="text" required
              autoComplete="organization-title"
              aria-describedby="job-name-help"
              value={jobName} onChange={(e) => setJobName(e.target.value)}
              placeholder="e.g. Senior Software Engineer"
            />
            <p id="job-name-help" className={styles.help}>
              Used to name the Drive folder and spreadsheet.
            </p>
          </div>

          <div className={styles.field}>
            <label htmlFor="company-name">
              Company Name <span aria-hidden="true">*</span>
            </label>
            <input
              id="company-name" name="companyName" type="text" required
              value={companyName} onChange={(e) => setCompanyName(e.target.value)}
              placeholder="e.g. Metaview"
            />
          </div>

          {showAdjacentRoles && (
            <div className={styles.field}>
              <label htmlFor="adjacent-roles">Adjacent Roles</label>
              <input
                id="adjacent-roles" name="adjacentRoles" type="text"
                aria-describedby="adjacent-help"
                value={adjacentRoles} onChange={(e) => setAdjacentRoles(e.target.value)}
                placeholder="e.g. AI Researcher, Applied Scientist"
              />
              <p id="adjacent-help" className={styles.help}>
                Tell the AI to also accept these roles as valid matches for the JD.
              </p>
            </div>
          )}

          <div className={styles.field}>
            <label htmlFor="notify-email">
              Notification recipients <span aria-hidden="true">*</span>
            </label>
            <input
              id="notify-email" name="email" type="email" multiple required
              autoComplete="email" inputMode="email"
              aria-describedby="notify-email-help"
              value={outreachEmail} onChange={(e) => setOutreachEmail(e.target.value)}
              placeholder="e.g. team@company.com"
            />
            <p id="notify-email-help" className={styles.help}>
              Comma-separated. Results are emailed here when the batch completes.
            </p>
          </div>

          <div className={styles.field}>
            <label htmlFor="jd-text">Job description <span aria-hidden="true">*</span></label>
            <textarea
              id="jd-text" name="jd" required rows={6} minLength={20}
              aria-describedby="jd-help"
              value={outreachJd} onChange={(e) => setOutreachJd(e.target.value)}
              placeholder="Enter the Job Description details here."
            />
            <p id="jd-help" className={styles.help}>
              Minimum 20 characters. Drives query expansion and LLM screening.
            </p>
          </div>
        </fieldset>

        {status && (
          <p id={errorId} role="alert" aria-live="assertive" className={styles.alert}>
            {status}
          </p>
        )}
      </div>

      <footer className={styles.footer}>
        <button type="button" onClick={onCancel} className={styles.cancelButton} disabled={isSubmitting}>
          Cancel
        </button>
        <button type="submit" disabled={isSubmitting} className={styles.submit}>
          {isSubmitting
            ? <><Loader2 size={16} className={styles.spin} aria-hidden="true" /> Dispatching…</>
            : 'Start AI Screening'}
        </button>
      </footer>
    </form>
  );
}
