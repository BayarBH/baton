import { existsSync, readFileSync } from 'node:fs';

// Adoption rate per rule from the sidebar's adopted/ignored verdicts (CLAUDE.md §9 hypothesis 2).
const file = process.argv[2] ?? process.env.BATON_FEEDBACK_FILE ?? 'data/feedback.jsonl';
if (!existsSync(file)) {
  console.error(`no feedback yet (${file})`);
  process.exit(1);
}

interface Row { meeting: string; nudge: string; ruleId: string; verdict: 'adopted' | 'ignored' }
const last = new Map<string, Row>(); // a facilitator can change their mind: the latest verdict counts
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  try {
    const r = JSON.parse(line) as Row;
    last.set(r.nudge, r);
  } catch {
    // skip a torn line
  }
}

const byRule = Map.groupBy(last.values(), (r) => r.ruleId);
console.log('rule                 judged  adopted  rate');
for (const [rule, rows] of [...byRule].sort()) {
  const adopted = rows.filter((r) => r.verdict === 'adopted').length;
  console.log(`${rule.padEnd(20)} ${String(rows.length).padStart(6)}  ${String(adopted).padStart(7)}  ${Math.round((100 * adopted) / rows.length)}%`);
}
console.log(`\n${last.size} nudges judged in ${new Set([...last.values()].map((r) => r.meeting)).size} meetings`);
