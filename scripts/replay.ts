import { parseArgs } from 'node:util';
import { mmss, replayFile } from '../src/replay.js';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { speed: { type: 'string', default: 'max' } } });
const file = positionals[0];
if (!file) {
  console.error('usage: npm run replay -- <fixture.json> [--speed 1x|10x|max]');
  process.exit(1);
}
const speed = values.speed === 'max' ? Infinity : Number(values.speed.replace(/x$/i, ''));
if (!(speed > 0)) {
  console.error(`invalid --speed "${values.speed}"`);
  process.exit(1);
}

// Privacy: print nudges and rule ids only, never transcript text.
const { nudges } = await replayFile(file, {
  speed,
  onNudge: (n) => console.log(`[${mmss(n.atMs)}] P${n.priority} ${n.ruleId.padEnd(18)} ${n.message}`),
});
const byRule = Object.entries(Object.groupBy(nudges, (n) => n.ruleId)).map(([k, v]) => `${k}=${v?.length}`);
console.log(`\n${nudges.length} nudges (${byRule.join(', ')})`);
