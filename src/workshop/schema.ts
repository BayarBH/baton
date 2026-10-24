import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const LocaleSchema = z.enum(['ja', 'zh', 'en']);
export type Locale = z.infer<typeof LocaleSchema>;

export const WorkshopStepSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeboxMin: z.number().positive(),
  goal: z.string(),
  expectedOutput: z.object({ description: z.string(), perParticipant: z.number().int().positive().optional() }).optional(),
  transition: z.enum(['on_timebox', 'on_output', 'either', 'manual']),
  warnAtRemainingMin: z.array(z.number().positive()).optional(),
  facilitatorScript: z.string().optional(),
  /** Heads-down work (e.g. Crazy 8s): silence is expected, so airtime rules stay quiet. */
  silentWork: z.boolean().optional(),
});

export const WorkshopScriptSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    locale: LocaleSchema,
    steps: z.array(WorkshopStepSchema).min(1),
  })
  .refine((s) => new Set(s.steps.map((x) => x.id)).size === s.steps.length, 'step ids must be unique');

export type WorkshopStep = z.infer<typeof WorkshopStepSchema>;
export type WorkshopScript = z.infer<typeof WorkshopScriptSchema>;

export function loadWorkshop(path: string): WorkshopScript {
  return WorkshopScriptSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}
