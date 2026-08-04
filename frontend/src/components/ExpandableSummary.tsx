import { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';

export function ExpandableSummary({ text, maxLength = 150 }: { text: string; maxLength?: number }) {
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > maxLength;
  const displayText = expanded || !needsTruncation ? text : text.substring(0, maxLength).trimEnd() + '…';

  return (
    <div>
      <div style={{ fontWeight: 500, fontSize: '0.85rem', lineHeight: '1.5', whiteSpace: 'pre-line' }}>{displayText}</div>
      {needsTruncation && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            background: 'none',
            border: 'none',
            color: '#60a5fa',
            cursor: 'pointer',
            padding: '0.25rem 0',
            fontSize: '0.8rem',
            display: 'flex',
            alignItems: 'center',
            gap: '0.25rem',
            marginTop: '0.25rem'
          }}
        >
          {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Read more</>}
        </button>
      )}
    </div>
  );
}
