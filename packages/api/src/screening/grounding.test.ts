import { describe, it, expect } from 'vitest';
import { verifyQuote, verifyQuotes, buildQuotableSource, normaliseForMatch } from './grounding';

const PROFILE = {
  name: 'Aiko Tanaka',
  headline: 'Senior Business Development Manager',
  current_company: 'Rakuten Group, Inc.',
  summary: 'Led enterprise partnerships across APAC, closing ¥1.2B in new revenue.',
  experience:
    'Rakuten Group\n↳ Senior Business Development Manager\nApr 2019 → Now (5 yrs 2 mos)\n' +
    'Built the drugstore channel from zero to 400 outlets.',
  education: 'BA Economics, Keio University',
};

describe('grounding', () => {
  const source = buildQuotableSource(PROFILE);

  it('verifies an exact quote', () => {
    expect(verifyQuote('Led enterprise partnerships across APAC', source)).toBe('verified');
  });

  it('verifies a quote whose formatting drifted', () => {
    // Models reliably reproduce words and unreliably reproduce punctuation,
    // casing and whitespace. That must not read as fabrication.
    expect(verifyQuote('led  ENTERPRISE partnerships, across APAC', source)).toBe('verified');
  });

  it('verifies a quote lifted across a line break', () => {
    expect(verifyQuote('Rakuten Group ↳ Senior Business Development Manager', source)).toBe(
      'verified',
    );
  });

  it('rejects a fabricated quote', () => {
    expect(verifyQuote('Managed a team of 40 engineers in Berlin', source)).toBe('unverified');
  });

  it('rejects a plausible-but-absent embellishment', () => {
    // The profile says ¥1.2B; this says $1.2B. A substring check that ignored
    // digits or currency would wave this through.
    expect(verifyQuote('closing $4.5B in new revenue', source)).toBe('unverified');
  });

  it('treats an honest no-evidence answer as abstention, not fabrication', () => {
    for (const marker of ['No evidence found', 'no evidence', 'N/A', 'none']) {
      expect(verifyQuote(marker, source)).toBe('abstained');
    }
  });

  it('treats an empty quote as abstention', () => {
    expect(verifyQuote('', source)).toBe('abstained');
    expect(verifyQuote('   ', source)).toBe('abstained');
  });

  it('ignores quotes too short to mean anything', () => {
    expect(verifyQuote('APAC', source)).toBe('trivial');
  });

  it('summarises a mixed set and flags fabrication', () => {
    const report = verifyQuotes(
      [
        'Built the drugstore channel from zero to 400 outlets',
        'Holds a PhD in Astrophysics',
        'No evidence found',
      ],
      PROFILE,
    );

    expect(report.verified).toBe(1);
    expect(report.unverified).toBe(1);
    expect(report.abstained).toBe(1);
    expect(report.hasFabrication).toBe(true);
  });

  it('does not flag fabrication when every quote is real or abstained', () => {
    const report = verifyQuotes(['BA Economics, Keio University', 'No evidence found'], PROFILE);
    expect(report.hasFabrication).toBe(false);
    expect(report.verified).toBe(1);
  });

  it('normalises unicode punctuation so smart quotes still match', () => {
    expect(normaliseForMatch('“Hello — world’s”')).toBe('hello world s');
  });

  it('builds a source spanning every quotable field', () => {
    expect(source).toContain('aiko tanaka');
    expect(source).toContain('keio university');
    expect(source).toContain('rakuten group');
  });
});
