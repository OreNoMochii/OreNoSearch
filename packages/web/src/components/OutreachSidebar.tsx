import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import { formatCost, type CatalogModel } from '../hooks/useModelCatalog';
import {
  Section,
  Field,
  TextInput,
  TextArea,
  Select,
  Button,
  Checkbox,
  Slider,
  Divider,
} from './ui';

export interface OutreachSidebarProps {
  jobName: string;
  setJobName: (v: string) => void;
  companyName: string;
  setCompanyName: (v: string) => void;
  outreachEmail: string;
  setOutreachEmail: (v: string) => void;
  outreachJd: string;
  setOutreachJd: (v: string) => void;
  adjacentRoles: string;
  setAdjacentRoles: (v: string) => void;

  screeningEngine: string;
  setScreeningEngine: (v: string) => void;
  selectedProvider: string;
  setSelectedProvider: (v: string) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;

  bypassDeduplication: boolean;
  setBypassDeduplication: (v: boolean) => void;
  useCompanyIntel: boolean;
  setUseCompanyIntel: (v: boolean) => void;
  usePipeline: boolean;
  setUsePipeline: (v: boolean) => void;

  pipelineTopN: number;
  setPipelineTopN: (v: number) => void;
  pipelineTopK: number;
  setPipelineTopK: (v: number) => void;
  treeTopK: number;
  setTreeTopK: (v: number) => void;

  pipelineMinExp: number | '';
  setPipelineMinExp: (v: number | '') => void;
  pipelineMaxExp: number | '';
  setPipelineMaxExp: (v: number | '') => void;

  isSubmitting: boolean;
  status: string | null;
  onSubmit: () => void;

  /**
   * Providers and models come from GET /api/models, never a hardcoded list.
   * This panel previously offered "OpenAI" and "Anthropic", neither of which
   * the backend routes — picking one gave an empty model dropdown and a
   * campaign that could not run.
   */
  availableProviders: string[];
  providerModels: CatalogModel[];
}

const PROVIDER_LABELS: Record<string, string> = {
  deepinfra: 'DeepInfra',
  nvidia: 'NVIDIA NIM',
};

/**
 * The four screening engines, as one list rather than four bespoke buttons.
 *
 * They were previously stacked full-width blocks in four different colours,
 * which read as four unrelated primary actions. They are one choice, so they
 * are presented as one: pick an engine, then run.
 */
const ENGINES = [
  { id: 'llm', label: 'AI + flight risk', blurb: 'LLM audit with attrition scoring' },
  { id: 'agentic', label: 'Agentic (grounded)', blurb: 'Rubric, evidence checks, challenger' },
  { id: 'tree', label: 'Tree-based ML', blurb: 'Fast local scoring, no LLM cost' },
  { id: 'tree_llm', label: 'Tree + AI hybrid', blurb: 'Cheap pre-filter, then LLM audit' },
] as const;

export function OutreachSidebar(props: OutreachSidebarProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const activeModel = props.providerModels.find((m) => m.id === props.selectedModel);
  const usesLlm = props.screeningEngine === 'llm' || props.screeningEngine === 'tree_llm';
  const usesTree = props.screeningEngine === 'tree' || props.screeningEngine === 'tree_llm';

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-line bg-panel p-6 pb-24">
      <h2 className="text-[17px] font-bold text-ink">Screening</h2>

      {/* ── The role ─────────────────────────────────────────────────── */}
      <Section title="The role">
        <Field label="Job title">
          <TextInput
            value={props.jobName}
            onChange={(e) => props.setJobName(e.target.value)}
            placeholder="e.g. Senior Software Engineer"
          />
        </Field>
        <Field label="Company">
          <TextInput
            value={props.companyName}
            onChange={(e) => props.setCompanyName(e.target.value)}
            placeholder="e.g. Stripe"
          />
        </Field>
        <Field label="Job description">
          <TextArea
            value={props.outreachJd}
            onChange={(e) => props.setOutreachJd(e.target.value)}
            placeholder="Paste the full job description…"
            className="min-h-[120px]"
          />
        </Field>
        <Field label="Notify" hint="Results are emailed here when the batch finishes.">
          <TextInput
            type="email"
            value={props.outreachEmail}
            onChange={(e) => props.setOutreachEmail(e.target.value)}
            placeholder="team@company.com"
          />
        </Field>
      </Section>

      <Divider />

      {/* ── Engine ───────────────────────────────────────────────────── */}
      <Section title="Engine">
        <div className="flex w-full flex-col gap-1.5">
          {ENGINES.map((e) => {
            const active = props.screeningEngine === e.id;
            return (
              <button
                key={e.id}
                type="button"
                onClick={() => props.setScreeningEngine(e.id)}
                aria-pressed={active}
                className={`flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-[6px] border px-3 py-2.5 text-left transition-colors ${
                  active
                    ? 'border-accent-line bg-accent-soft'
                    : 'border-transparent bg-input hover:bg-input-hover'
                }`}
              >
                <span
                  className={`text-[12.5px] font-semibold ${active ? 'text-accent' : 'text-ink'}`}
                >
                  {e.label}
                </span>
                <span className="text-[10.5px] leading-snug text-ink-3">{e.blurb}</span>
              </button>
            );
          })}
        </div>
      </Section>

      {usesLlm && (
        <>
          <Divider />
          <Section title="Model">
            <Field label="Provider">
              <Select
                value={props.selectedProvider}
                onChange={(e) => props.setSelectedProvider(e.target.value)}
              >
                {props.availableProviders.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p] ?? p}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Analytical model"
              hint={
                activeModel ? (
                  <>
                    {formatCost(activeModel)}
                    {activeModel.contextTokens
                      ? ` · ${Math.round(activeModel.contextTokens / 1000)}k context`
                      : ''}
                    {activeModel.reasoning ? ' · reasoning' : ''}
                  </>
                ) : undefined
              }
            >
              <Select
                value={props.selectedModel}
                onChange={(e) => props.setSelectedModel(e.target.value)}
              >
                {props.providerModels.map((m) => (
                  // `label`, not `name` — the catalogue has no `name` field, so
                  // these options were rendering blank.
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Adjacent roles" hint="Titles to treat as equivalent.">
              <TextInput
                value={props.adjacentRoles}
                onChange={(e) => props.setAdjacentRoles(e.target.value)}
                placeholder="e.g. Platform Engineer, SRE"
              />
            </Field>
          </Section>
        </>
      )}

      <Divider />

      {/* ── Behaviour ────────────────────────────────────────────────── */}
      <Section title="Behaviour">
        <Checkbox checked={props.bypassDeduplication} onChange={props.setBypassDeduplication}>
          Force retry — ignore submission history and screen everyone again
        </Checkbox>
        <Checkbox checked={props.useCompanyIntel} onChange={props.setUseCompanyIntel}>
          Use company intel — attach employer metadata before screening
        </Checkbox>

        {usesTree && (
          <Slider
            label="Tree shortlist (top-K)"
            value={props.treeTopK}
            min={10}
            max={2000}
            step={10}
            onChange={props.setTreeTopK}
          />
        )}
      </Section>

      <Divider />

      {/* ── Advanced ─────────────────────────────────────────────────── */}
      <Section>
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          aria-expanded={advancedOpen}
          className="flex w-full cursor-pointer items-center justify-between gap-2 border-none bg-transparent p-0 text-left"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[1.2px] text-ink-3">
            Advanced pipeline
          </span>
          {advancedOpen ? (
            <ChevronDown size={14} aria-hidden="true" className="text-ink-3" />
          ) : (
            <ChevronRight size={14} aria-hidden="true" className="text-ink-3" />
          )}
        </button>

        {advancedOpen && (
          <div className="flex w-full flex-col gap-4 rounded-[6px] bg-input p-3">
            <Checkbox checked={props.usePipeline} onChange={props.setUsePipeline}>
              Use dense retrieval — the service sources its own candidates
            </Checkbox>
            <Slider
              label="Retrieve top-N"
              value={props.pipelineTopN}
              min={50}
              max={1000}
              step={25}
              onChange={props.setPipelineTopN}
            />
            <Slider
              label="Rerank to top-K"
              value={props.pipelineTopK}
              min={10}
              max={500}
              step={10}
              onChange={props.setPipelineTopK}
            />
            <div className="flex gap-2.5">
              <Field label="Min years">
                <TextInput
                  type="number"
                  min={0}
                  max={60}
                  value={props.pipelineMinExp}
                  onChange={(e) =>
                    props.setPipelineMinExp(
                      e.target.value === '' ? '' : parseInt(e.target.value, 10),
                    )
                  }
                  placeholder="auto"
                />
              </Field>
              <Field label="Max years">
                <TextInput
                  type="number"
                  min={0}
                  max={60}
                  value={props.pipelineMaxExp}
                  onChange={(e) =>
                    props.setPipelineMaxExp(
                      e.target.value === '' ? '' : parseInt(e.target.value, 10),
                    )
                  }
                  placeholder="auto"
                />
              </Field>
            </div>
          </div>
        )}
      </Section>

      {props.status && (
        <p className="rounded-[6px] bg-accent-soft px-3 py-2.5 text-[12px] font-medium text-accent">
          {props.status}
        </p>
      )}

      <Button tone="primary" full disabled={props.isSubmitting} onClick={props.onSubmit}>
        {props.isSubmitting ? (
          <>
            <Loader2 size={13} aria-hidden="true" className="animate-spin" /> Dispatching…
          </>
        ) : (
          'Run screening'
        )}
      </Button>
    </aside>
  );
}
