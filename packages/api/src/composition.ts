/**
 * composition.ts — the composition root.
 *
 * This is the only module that knows both the domain ports and their concrete
 * implementations. Wiring previously sat at the bottom of
 * services/OutreachOrchestrator.ts, below the class, with the adapter imports
 * trailing after it — so the orchestrator transitively depended on every
 * adapter, on Google APIs, on Redis and on the Python runner. Importing it in
 * a test pulled all of that in.
 *
 * Keeping construction here means the orchestrator depends only on interfaces.
 */
import { config } from './config';
import type { ScreeningStrategy } from './domain/ports';
import { OutreachOrchestrator } from './services/OutreachOrchestrator';

import { TreeScreeningAdapter } from './infrastructure/TreeScreeningAdapter';
import { LlmScreeningAdapter } from './infrastructure/LlmScreeningAdapter';
import { PipelineScreeningAdapter } from './infrastructure/PipelineScreeningAdapter';
import { HybridScreeningAdapter } from './infrastructure/HybridScreeningAdapter';
import { HttpRiskScorer } from './infrastructure/HttpRiskScorer';
import { GoogleSheetsSink } from './infrastructure/GoogleSheetsSink';
import { EmailNotifier } from './infrastructure/EmailNotifier';
import { PostgresOutreachHistory } from './infrastructure/PostgresOutreachHistory';
import { PostgresCandidateSource } from './infrastructure/PostgresCandidateSource';
import { QueueProgressReporter } from './infrastructure/QueueProgressReporter';

const progress = new QueueProgressReporter();

// Shared instances: the hybrid engine composes the same adapters the standalone
// engines use, rather than duplicating their behaviour.
const treeAdapter = new TreeScreeningAdapter(progress);
const llmAdapter = new LlmScreeningAdapter(progress);
const pipelineAdapter = new PipelineScreeningAdapter(progress);

const strategies: ReadonlyMap<string, ScreeningStrategy> = new Map<string, ScreeningStrategy>([
  ['tree', treeAdapter],
  ['llm', llmAdapter],
  ['pipeline', pipelineAdapter],
  // Was `new LlmScreeningAdapter()`, which skipped the tree pre-filter
  // entirely and made Hybrid the most expensive engine rather than the
  // cheapest.
  ['tree_llm', new HybridScreeningAdapter(treeAdapter, llmAdapter)],
]);

export const outreachOrchestrator = new OutreachOrchestrator(
  strategies,
  new HttpRiskScorer(config.ML_SCORING_URL, config.RETRIEVAL_TIMEOUT_MS),
  new GoogleSheetsSink(),
  new EmailNotifier(),
  new PostgresOutreachHistory(),
  new PostgresCandidateSource(),
  progress,
);
