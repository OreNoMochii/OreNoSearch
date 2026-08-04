import { z } from 'zod';
import { RiskScore, RiskScorer } from '../domain/ports';

const ScoringCandidateResult = z.object({
  hazard: z.number(),
  relevancy: z.number(),
  move_prob: z.number(),
  tenure: z.number(),
});

const ScoringResponse = z.object({
  scored_candidates: z.record(z.string(), ScoringCandidateResult),
});

function toRiskScore(val: z.infer<typeof ScoringCandidateResult>): RiskScore {
  return {
    hazard: val.hazard,
    relevancy: val.relevancy,
    moveProb: val.move_prob,
    tenureMonths: val.tenure,
  };
}

export class ScoringUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScoringUnavailableError';
  }
}

export class HttpRiskScorer implements RiskScorer {
  constructor(private readonly baseUrl: string, private readonly timeoutMs: number) {}

  async score(profileUrls: readonly string[], jdText: string): Promise<ReadonlyMap<string, RiskScore>> {
    if (profileUrls.length === 0) return new Map();
    
    // Explicit Node fetch call
    const res = await fetch(`${this.baseUrl}/score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile_urls: profileUrls, jd_text: jdText }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    
    if (!res.ok) throw new ScoringUnavailableError(`Scoring service returned ${res.status}`);
    
    const parsed = ScoringResponse.safeParse(await res.json());
    if (!parsed.success) throw new ScoringUnavailableError('Malformed scoring response');
    
    return new Map(Object.entries(parsed.data.scored_candidates).map(([k, v]) => [k, toRiskScore(v)]));
  }
}
