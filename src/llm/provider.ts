import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import type { Locale } from '../workshop/schema.js';

const Item = { id: z.string().nullable() };
export const AnalysisSchema = z.object({
  decisions: z.array(z.object({ ...Item, text: z.string() })),
  actionItems: z.array(z.object({ ...Item, text: z.string(), owner: z.string().nullable() })),
  openQuestions: z.array(z.object({ ...Item, text: z.string() })),
  /** The topic debated at length with no conclusion; `sinceUtterance` = utterance index where the debate began. */
  unresolvedTopic: z.object({ topic: z.string(), sinceUtterance: z.number(), continuesKnown: z.boolean() }).nullable(),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

type Known<T> = (Omit<T, 'id'> & { id: string })[];
export interface AnalyzeInput {
  locale: Locale;
  utterances: { i: number; atMs: number; speaker: string; text: string }[];
  known: {
    decisions: Known<Analysis['decisions'][number]>;
    actionItems: Known<Analysis['actionItems'][number]>;
    openQuestions: Known<Analysis['openQuestions'][number]>;
    unresolvedTopic: string | null;
  };
}

/** The only thing Baton needs from an LLM. Tests use a fake; ClaudeProvider is the real one. */
export interface LlmProvider {
  /** null = no usable answer this time (refusal, malformed output). Throw LlmConfigError for unrecoverable setup errors. */
  analyze(input: AnalyzeInput): Promise<Analysis | null>;
}

/** Misconfiguration (no credentials, bad key): retrying will not help, so the session stops. */
export class LlmConfigError extends Error {}

const SYSTEM = `You track the state of a live meeting for a facilitator. The transcript may mix Japanese, Chinese and English.
Given the known items and the most recent utterances, return the COMPLETE current lists:
- decisions: things the group explicitly agreed or the decider settled. Not proposals.
- actionItems: concrete follow-up tasks. owner = the participant name who took it, or null if nobody committed.
- openQuestions: questions raised and not yet answered.
- unresolvedTopic: the one topic being debated repeatedly without reaching a conclusion, or null. sinceUtterance = index i of the utterance where that debate began. continuesKnown = true if it is the same debate as the known unresolvedTopic.
For an item that is already known, return its id and keep its text unless it genuinely changed (update owner when someone takes a task). New items get id null. Drop known items only if the transcript clearly contradicts them.
Keep item text short. Write item text in this language: `;

const LANG: Record<Locale, string> = { ja: 'Japanese', zh: 'Simplified Chinese', en: 'English' };
const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
const FORMAT = betaZodOutputFormat(AnalysisSchema);

export class ClaudeProvider implements LlmProvider {
  // Calls are awaited inline by the session, so keep a stuck request from stalling live timebox nudges.
  private readonly client = new Anthropic({ timeout: 30_000, maxRetries: 1 });

  constructor(private readonly model = process.env.BATON_LLM_MODEL) {
    if (!model) throw new LlmConfigError('BATON_LLM_MODEL is not set (see .env.example)');
  }

  async analyze(input: AnalyzeInput): Promise<Analysis | null> {
    const transcript = input.utterances.map((u) => `[${u.i}] ${mmss(u.atMs)} ${u.speaker}: ${u.text}`).join('\n');
    let res;
    try {
      res = await this.client.beta.messages.create({
        model: this.model!,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: FORMAT },
        system: SYSTEM + LANG[input.locale],
        messages: [{ role: 'user', content: `Known items:\n${JSON.stringify(input.known)}\n\nRecent utterances:\n${transcript}` }],
      });
    } catch (err) {
      // Transient API errors (429/5xx/network) propagate and the tracker retries; setup errors are fatal.
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError || !(err instanceof Anthropic.APIError)) {
        throw new LlmConfigError(`Claude setup error (${(err as Error).name}): check ANTHROPIC_API_KEY / BATON_LLM_MODEL in .env`);
      }
      throw err;
    }
    if (res.stop_reason !== 'end_turn') return null; // refusal, max_tokens, ...
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      return AnalysisSchema.parse(JSON.parse(text));
    } catch {
      return null;
    }
  }
}
