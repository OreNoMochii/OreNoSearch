import { MapPin, X } from 'lucide-react';

interface LocationPickerProps {
  /** Free-text filter over the available list. */
  locationSearch: string;
  onLocationSearchChange: (value: string) => void;
  /** Full list from the API. */
  availableLocations: string[];
  /** Memoised subset matching locationSearch. */
  visibleLocations: string[];
  selectedLocations: string[];
  onSelectedLocationsChange: (next: string[]) => void;
}

/**
 * Step 1 of the search form: choose one or more target regions.
 *
 * Extracted verbatim from App.tsx, where it accounted for 236 lines and 19
 * inline style objects. The markup is unchanged in this step so the move
 * carries no visual risk; styling migrates to a CSS module separately.
 *
 * State stays in App.tsx — this component is presentational and receives
 * everything it needs, which is what makes it renderable in isolation.
 */
export function LocationPicker({
  locationSearch,
  onLocationSearchChange,
  availableLocations,
  visibleLocations,
  selectedLocations,
  onSelectedLocationsChange,
}: LocationPickerProps) {
  return (
    <div
      className="input-group"
      style={{
        border: '2px solid rgba(59, 130, 246, 0.5)',
        padding: '1rem',
        borderRadius: '0.75rem',
        background: 'rgba(59, 130, 246, 0.05)',
        marginBottom: '1.5rem',
      }}
    >
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          color: '#60a5fa',
          fontSize: '1.1rem',
          marginBottom: '1rem',
        }}
      >
        <MapPin size={20} />
        Step 1: Select Target Locations (Required)
      </label>
      <div
        style={{
          background: 'rgba(15, 23, 42, 0.5)',
          border: '1px solid rgba(255,255,255,0.2)',
          borderRadius: '0.5rem',
          padding: '0.5rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.4rem',
        }}
      >
        <input
          type="text"
          value={locationSearch}
          onChange={(e) => onLocationSearchChange(e.target.value)}
          placeholder="Search locations..."
          style={{
            width: '100%',
            padding: '0.5rem',
            borderRadius: '0.25rem',
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#fff',
            outline: 'none',
            fontSize: '0.85rem',
          }}
        />
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.25rem' }}>
          <button
            type="button"
            onClick={() => {
              const matching = visibleLocations;
              const toAdd = matching.filter((loc) => !selectedLocations.includes(loc));
              onSelectedLocationsChange([...selectedLocations, ...toAdd]);
            }}
            style={{
              flex: 1,
              background: 'rgba(59, 130, 246, 0.2)',
              border: '1px solid rgba(59, 130, 246, 0.3)',
              color: '#93c5fd',
              padding: '0.3rem',
              borderRadius: '0.25rem',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Check All
          </button>
          <button
            type="button"
            onClick={() => {
              const matching = visibleLocations;
              onSelectedLocationsChange(selectedLocations.filter((loc) => !matching.includes(loc)));
            }}
            style={{
              flex: 1,
              background: 'rgba(239, 68, 68, 0.2)',
              border: '1px solid rgba(239, 68, 68, 0.3)',
              color: '#fca5a5',
              padding: '0.3rem',
              borderRadius: '0.25rem',
              fontSize: '0.8rem',
              cursor: 'pointer',
            }}
          >
            Uncheck All
          </button>
        </div>
        <div
          style={{
            maxHeight: '150px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.4rem',
          }}
        >
          {availableLocations.length === 0 && (
            <div
              style={{
                padding: '0.5rem',
                color: '#94a3b8',
                fontSize: '0.85rem',
                fontStyle: 'italic',
              }}
            >
              No locations found. (Loading...)
            </div>
          )}
          {visibleLocations.map((loc) => (
            <label
              key={loc}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.5rem',
                cursor: 'pointer',
                margin: 0,
                padding: '0.2rem 0.5rem',
                borderRadius: '0.25rem',
              }}
            >
              <input
                type="checkbox"
                checked={selectedLocations.includes(loc)}
                onChange={(e) => {
                  if (e.target.checked) {
                    onSelectedLocationsChange([...selectedLocations, loc]);
                  } else {
                    onSelectedLocationsChange(selectedLocations.filter((l) => l !== loc));
                  }
                }}
                style={{ cursor: 'pointer', accentColor: '#3b82f6' }}
              />
              <span style={{ color: '#e2e8f0', fontSize: '0.9rem' }}>{loc}</span>
            </label>
          ))}
        </div>
        {selectedLocations.length > 0 && (
          <div
            style={{
              marginTop: '0.75rem',
              paddingTop: '0.5rem',
              borderTop: '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '0.5rem',
              }}
            >
              <span style={{ fontSize: '0.8rem', color: '#94a3b8', fontWeight: 600 }}>
                Active Location Filters ({selectedLocations.length}):
              </span>
              <button
                type="button"
                onClick={() => onSelectedLocationsChange([])}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#fca5a5',
                  fontSize: '0.75rem',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Clear All
              </button>
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.4rem',
                maxHeight: '120px',
                overflowY: 'auto',
                padding: '0.2rem',
              }}
            >
              {selectedLocations.map((loc) => (
                <div
                  key={loc}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.35rem',
                    background: 'rgba(59, 130, 246, 0.2)',
                    border: '1px solid rgba(59, 130, 246, 0.4)',
                    borderRadius: '1rem',
                    padding: '0.2rem 0.65rem 0.2rem 0.4rem',
                    fontSize: '0.8rem',
                    color: '#e2e8f0',
                  }}
                >
                  <button
                    type="button"
                    onClick={() =>
                      onSelectedLocationsChange(selectedLocations.filter((l) => l !== loc))
                    }
                    title={`Remove ${loc}`}
                    style={{
                      background: 'rgba(239, 68, 68, 0.3)',
                      border: 'none',
                      borderRadius: '50%',
                      width: '16px',
                      height: '16px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      padding: 0,
                      color: '#fca5a5',
                    }}
                  >
                    <X size={10} />
                  </button>
                  <span>{loc}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
      <span className="input-helper">
        You must select at least one location before running a search.
      </span>
    </div>
  );
}
