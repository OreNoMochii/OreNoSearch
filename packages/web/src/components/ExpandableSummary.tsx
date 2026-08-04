import { useId, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import styles from './ExpandableSummary.module.css';

interface ExpandableSummaryProps {
  text: string;
  maxLength?: number;
}

/**
 * Truncated candidate summary with a show more/less toggle.
 *
 * Accessibility: the toggle is a real button carrying aria-expanded and
 * aria-controls, so assistive technology can report the collapsed/expanded
 * state and locate the region it governs. The previous version was an
 * unlabelled button with no state exposed at all.
 */
export function ExpandableSummary({ text, maxLength = 150 }: ExpandableSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const regionId = useId();

  const needsTruncation = text.length > maxLength;
  const displayText =
    expanded || !needsTruncation ? text : `${text.substring(0, maxLength).trimEnd()}…`;

  return (
    <div>
      <p id={regionId} className={styles.text}>
        {displayText}
      </p>

      {needsTruncation ? (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? (
            <>
              <ChevronUp size={14} aria-hidden="true" /> Show less
            </>
          ) : (
            <>
              <ChevronDown size={14} aria-hidden="true" /> Read more
            </>
          )}
        </button>
      ) : null}
    </div>
  );
}
