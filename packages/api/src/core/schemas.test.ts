import { describe, it, expect } from 'vitest';
import {
  OutreachRequest,
  SqlSearchRequest,
  MeiliProxyRequest,
  VerificationResponse,
  CandidateInput,
} from './schemas';

const validOutreach = {
  jd: 'A job description long enough to satisfy the minimum length rule.',
  email: 'recruiter@example.com',
  jobName: 'Senior Engineer',
  companyName: 'Acme',
};

describe('OutreachRequest', () => {
  describe('B1 — defence in depth for the Python boundary', () => {
    it('rejects a profile_url that is not a URL', () => {
      // profile_url reaches the ML scoring subprocess. Constraining it to
      // a well-formed URL makes shell metacharacters unrepresentable
      // rather than merely escaped.
      const r = OutreachRequest.safeParse({
        ...validOutreach,
        candidates: [{ profile_url: "'; rm -rf /; echo '" }],
      });
      expect(r.success).toBe(false);
    });

    it.each(['$(whoami)', '`id`', '; cat /etc/passwd', 'http://ok.com; rm -rf /'])(
      'rejects shell-shaped profile_url %j',
      (url) => {
        expect(CandidateInput.safeParse({ profile_url: url }).success).toBe(false);
      },
    );

    it('accepts a well-formed profile_url', () => {
      const r = OutreachRequest.safeParse({
        ...validOutreach,
        candidates: [{ profile_url: 'https://linkedin.com/in/someone' }],
      });
      expect(r.success).toBe(true);
    });

    it('preserves unknown candidate fields for the screening prompt', () => {
      const r = CandidateInput.safeParse({
        profile_url: 'https://x.com/a',
        some_future_field: 'kept',
      });
      expect(r.success).toBe(true);
      if (r.success) expect(r.data).toHaveProperty('some_future_field', 'kept');
    });
  });

  describe('recipient validation', () => {
    it('rejects a malformed recipient', () => {
      expect(OutreachRequest.safeParse({ ...validOutreach, email: 'not-an-email' }).success).toBe(
        false,
      );
    });

    it('accepts a comma-separated recipient list', () => {
      expect(
        OutreachRequest.safeParse({ ...validOutreach, email: 'a@b.com, c@d.com' }).success,
      ).toBe(true);
    });

    it('rejects a list containing one bad entry', () => {
      expect(
        OutreachRequest.safeParse({ ...validOutreach, email: 'a@b.com, garbage' }).success,
      ).toBe(false);
    });
  });

  describe('bounds and defaults', () => {
    it('rejects a job description below the minimum length', () => {
      expect(OutreachRequest.safeParse({ ...validOutreach, jd: 'too short' }).success).toBe(false);
    });

    it('applies documented defaults', () => {
      const r = OutreachRequest.parse(validOutreach);
      expect(r.screeningEngine).toBe('llm');
      expect(r.usePipeline).toBe(false);
      expect(r.useCompanyIntel).toBe(true);
      expect(r.bypassDeduplication).toBe(false);
      expect(r.candidates).toEqual([]);
    });

    it.each([
      ['topN', 49],
      ['topN', 1001],
      ['topK', 9],
      ['topK', 501],
      ['minExp', -1],
      ['maxExp', 61],
    ])('rejects out-of-range %s = %d', (field, value) => {
      expect(OutreachRequest.safeParse({ ...validOutreach, [field]: value }).success).toBe(false);
    });

    it('rejects an unknown screening engine', () => {
      expect(
        OutreachRequest.safeParse({ ...validOutreach, screeningEngine: 'magic' }).success,
      ).toBe(false);
    });
  });
});

describe('SqlSearchRequest', () => {
  it('defaults every optional collection so the repository never sees undefined', () => {
    const r = SqlSearchRequest.parse({});
    expect(r.andGroups).toEqual([]);
    expect(r.must).toEqual([]);
    expect(r.locations).toEqual([]);
    expect(r.limit).toBe(25);
  });

  it('bounds the result limit', () => {
    expect(SqlSearchRequest.safeParse({ limit: 0 }).success).toBe(false);
    expect(SqlSearchRequest.safeParse({ limit: 100_001 }).success).toBe(false);
    expect(SqlSearchRequest.safeParse({ limit: 100_000 }).success).toBe(true);
  });

  it('caps collection sizes so a request cannot blow up the query planner', () => {
    expect(SqlSearchRequest.safeParse({ must: Array(51).fill('x') }).success).toBe(false);
    expect(SqlSearchRequest.safeParse({ andGroups: Array(21).fill(['x']) }).success).toBe(false);
  });
});

describe('MeiliProxyRequest', () => {
  // B2: the browser holds no Meilisearch key; this is the shape it may send.
  it('bounds limit and offset', () => {
    expect(
      MeiliProxyRequest.safeParse({ index: 'candidates', query: 'x', limit: 1001 }).success,
    ).toBe(false);
    expect(
      MeiliProxyRequest.safeParse({ index: 'candidates', query: 'x', offset: -1 }).success,
    ).toBe(false);
  });

  it('applies defaults', () => {
    const r = MeiliProxyRequest.parse({ index: 'candidates', query: 'engineer' });
    expect(r.limit).toBe(20);
    expect(r.offset).toBe(0);
  });

  it('bounds the query length', () => {
    expect(
      MeiliProxyRequest.safeParse({ index: 'candidates', query: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('VerificationResponse', () => {
  describe('B7 — malformed LLM output', () => {
    it('requires only final_verdict', () => {
      const r = VerificationResponse.safeParse({ final_verdict: 'RETAIN' });
      expect(r.success).toBe(true);
    });

    it('rejects a response missing final_verdict rather than throwing later', () => {
      // Previously this parsed, then `result.final_verdict.includes(...)`
      // raised a TypeError inside the retry loop and burned ~100s of
      // backoff on a deterministic failure.
      expect(VerificationResponse.safeParse({ overall_fit_score: '4' }).success).toBe(false);
    });

    it('defaults every optional section so field access is safe', () => {
      const r = VerificationResponse.parse({ final_verdict: 'REJECT' });
      expect(r.technical_audit).toEqual([]);
      expect(r.candidate_summary).toEqual({});
      expect(r.overall_fit_score).toBe('0');
    });

    it('coerces a numeric fit score to a string', () => {
      expect(
        VerificationResponse.parse({ final_verdict: 'RETAIN', overall_fit_score: 5 })
          .overall_fit_score,
      ).toBe('5');
    });

    it('tolerates partial technical_audit entries', () => {
      const r = VerificationResponse.safeParse({
        final_verdict: 'REJECT',
        technical_audit: [{ requirement: 'Go' }, {}],
      });
      expect(r.success).toBe(true);
    });
  });
});
