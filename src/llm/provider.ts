import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Locale } from '../workshop/schema.js';

export const AnalysisSchema = z.object({
  decisions: z.array(z.object({ text: z.string() })),
  actionItems: z.array(z.object({ text: z.string(), owner: z.string().nullable() })),
  openQuestions: z.array(z.object({ text: z.string() })),
  /** A topic discussed at length with no conclusion yet; `sinceUtterance` is the `i` where it started. */
  unresolvedTopic: z.object({ topic: z.string(), sinceUtterance: z.number() }).nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export interface AnalyzeInput {
  locale: Locale;
  utterances: { i: number; atMs: number; speaker: string; text: string }[];
  known: Pick<Analysis, 'decisions' | 'actionItems' | 'openQuestions'>;
}

/** The only thing Baton needs from an LLM. Tests use a fake; ClaudeProvider is the real one. */
export interface LlmProvider {
  analyze(input: AnalyzeInput): Promise<Analysis | null>;
}

const SYSTEM = `You track the state of a live meeting for a facilitator. The transcript may mix Japanese, Chinese and English.
Given the items already known and the most recent utterances, return the COMPLETE current lists:
- decisions: things the group explicitly agreed or the decider settled. Not proposals.
- actionItems: concrete follow-up tasks. owner = the participant name who took it, or null if nobody committed.
- openQuestions: questions raised and not yet answered.
- unresolvedTopic: the one topic being debated repeatedly without reaching a conclusion, with the index i of the utterance where that debate began; null if none.
Keep known items unless the transcript clearly contradicts them (update owner when someone takes a task). Keep item text short. Write item text in this language: `;

const LANG: Record<Locale, string> = { ja: 'Japanese', zh: 'Simplified Chinese', en: 'English' };
const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;

export class ClaudeProvider implements LlmProvider {
  private readonly client = new Anthropic();

  constructor(private readonly model = process.env.BATON_LLM_MODEL) {
    if (!model) throw new Error('BATON_LLM_MODEL is not set (see .env.example)');
  }

  async analyze(input: AnalyzeInput): Promise<Analysis | null> {
    const transcript = input.utterances.map((u) => `[${u.i}] ${mmss(u.atMs)} ${u.speaker}: ${u.text}`).join('\n');
    const res = await this.client.beta.messages.parse({
      model: this.model!,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low', format: betaZodOutputFormat(AnalysisSchema) },
      system: SYSTEM + LANG[input.locale],
      messages: [{ role: 'user', content: `Known items:\n${JSON.stringify(input.known)}\n\nRecent utterances:\n${transcript}` }],
    });
    if (res.stop_reason === 'refusal') return null;
    return res.parsed_output ?? null;
  }
}
