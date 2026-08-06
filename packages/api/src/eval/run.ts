/**
 * run.ts — the eval CLI.
 *
 *   npm run eval:mine   --workspace @metaview/api      bootstrap weak labels
 *   npm run eval:report --workspace @metaview/api      score the last run
 *   npm run eval        --workspace @metaview/api -- --jd path/to/jd.txt
 *
 * The point of this file is that "did that prompt change help?" becomes a
 * command rather than an opinion.
 */
import fs from 'fs';
import { pool, getCandidatesByUrl } from '../repositories/postgres_repo';
import { hashJd } from '../repositories/screening_repo';
import { compileRubric } from '../screening/rubric';
import { screenCandidate } from '../screening/pipeline';
import { mineWeakLabels, saveLabels, loadGoldenSet } from './goldenSet';
import { scoreRun, scoreCost, formatReport, type ScoredPair } from './score';
import type { ScreenedCandidate } from '../domain/ports';

/** Maps a golden pair's DB row onto the shape the pipeline screens. */
function toScreened(row: Record<string, unknown>): ScreenedCandidate {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim().length > 0 ? v : undefined;
  return {
    profileUrl: str(row.folder_id ?? row.resume_drive_view_url) ?? 'N/A',
    name: str(row.full_name) ?? 'Unknown',
    currentCompany: str(row.ai_latest_company),
    location: str(row.ai_latest_location),
    headline: str(row.ai_latest_role),
    experience: str(row.resume_text_excerpt),
    summary: str(row.candidate_summary),
    education: str(row.education),
    skills: str(row.skills),
  };
}

async function mine(): Promise<void> {
  // Campaign -> JD text. The JD is not stored per campaign anywhere today, so
  // it has to be supplied. Without it a label cannot be keyed to a rubric.
  const mapPath = process.env.EVAL_JD_MAP;
  if (!mapPath || !fs.existsSync(mapPath)) {
    console.error(
      'Set EVAL_JD_MAP to a JSON file mapping "Company::Job" -> JD text.\n' +
        'Example: { "Craif Inc::Business Development Manager": "Business Development..." }\n\n' +
        'Campaign JDs are not persisted today, so they must be supplied once to\n' +
        'key historical decisions to a rubric hash.',
    );
    process.exitCode = 1;
    return;
  }

  const raw = JSON.parse(fs.readFileSync(mapPath, 'utf8')) as Record<string, string>;
  const jdMap = new Map(Object.entries(raw));

  const labels = await mineWeakLabels(jdMap);
  const written = await saveLabels(labels);

  console.log(`\nMined ${labels.length} weak labels, wrote ${written}.`);
  console.log(`  FIT     ${labels.filter((l) => l.label === 'FIT').length}  (contacted)`);
  console.log(
    `  NOT_FIT ${labels.filter((l) => l.label === 'NOT_FIT').length}  (passed, never contacted)`,
  );
  console.log(
    `\nThese are WEAK labels. "Never contacted" may mean the recruiter simply\n` +
      `stopped reading, and rejected candidates are absent entirely — so recall\n` +
      `against this set is an upper bound. Promote a sample to human_review\n` +
      `before using any of it as a release gate.\n`,
  );
}

async function evaluate(jdPath: string, limit: number): Promise<void> {
  if (!fs.existsSync(jdPath)) {
    console.error(`JD file not found: ${jdPath}`);
    process.exitCode = 1;
    return;
  }
  const jdText = fs.readFileSync(jdPath, 'utf8');
  const jdHash = hashJd(jdText);

  const golden = (await loadGoldenSet({ limit })).filter((g) => g.jdHash === jdHash);
  if (golden.length === 0) {
    console.error(
      `No labels for this JD (hash ${jdHash}).\n` +
        `Run the miner first, or add rows to eval_labels for this jd_hash.`,
    );
    process.exitCode = 1;
    return;
  }

  const compiled = await compileRubric({ jdText });
  if (!compiled) {
    console.error('Rubric compilation failed.');
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nRubric: ${compiled.rubric.knockouts.length} knockouts, ` +
      `${compiled.rubric.competencies.length} competencies` +
      `${compiled.fromCache ? ' (cached)' : ''}`,
  );
  if (compiled.rubric.open_questions.length > 0) {
    console.log(`\n  Open questions the rubric could not resolve:`);
    for (const q of compiled.rubric.open_questions) console.log(`    - ${q}`);
  }

  const rows = await getCandidatesByUrl(golden.map((g) => g.profileUrl));
  const byUrl = new Map(rows.map((r) => [r.folder_id as string, r]));

  const pairs: ScoredPair[] = [];
  let llmCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let fabricated = 0;
  let totalQuotes = 0;

  console.log(`\nScreening ${golden.length} labelled candidates...\n`);

  for (const [i, g] of golden.entries()) {
    const row = byUrl.get(g.profileUrl);
    if (!row) continue;

    const outcome = await screenCandidate(toScreened(row), compiled.rubric);
    pairs.push({
      profileUrl: g.profileUrl,
      predicted: outcome.decision,
      actual: g.label,
      weight: g.confidence,
    });

    llmCalls += outcome.usage.calls;
    promptTokens += outcome.usage.promptTokens;
    completionTokens += outcome.usage.completionTokens;
    fabricated += outcome.fabricatedQuotes;
    totalQuotes += outcome.verifiedQuotes + outcome.fabricatedQuotes;

    if ((i + 1) % 10 === 0) process.stdout.write(`  ${i + 1}/${golden.length}\r`);
  }

  const metrics = scoreRun(pairs);
  const cost = scoreCost({
    llmCalls,
    promptTokens,
    completionTokens,
    candidates: pairs.length,
    fabricatedQuotes: fabricated,
    totalQuotes,
  });

  console.log(formatReport('agentic pipeline', metrics, cost));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? 'help';

  try {
    if (command === 'mine') {
      await mine();
    } else if (command === 'run') {
      const jdIndex = args.indexOf('--jd');
      if (jdIndex === -1 || !args[jdIndex + 1]) {
        console.error('Usage: eval run --jd <path> [--limit N]');
        process.exitCode = 1;
        return;
      }
      const limitIndex = args.indexOf('--limit');
      const limit = limitIndex !== -1 ? Number(args[limitIndex + 1]) : 200;
      await evaluate(args[jdIndex + 1], limit);
    } else {
      console.log(
        `\nScreening eval harness\n\n` +
          `  mine                      bootstrap weak labels from screening + outreach history\n` +
          `                            (requires EVAL_JD_MAP)\n` +
          `  run --jd <path> [--limit] screen the labelled set for that JD and report metrics\n`,
      );
    }
  } finally {
    await pool.end();
  }
}

void main();
