import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { ReplaySource } from '../src/ingest/replay-source.js';
import { ClaudeProvider, LlmConfigError } from '../src/llm/provider.js';
import { loadReplay } from '../src/replay.js';
import { createBatonServer, type ZoomCredentials } from '../src/server.js';
import { Session } from '../src/session.js';
import { LocaleSchema, loadWorkshop } from '../src/workshop/schema.js';

const USAGE = 'usage: npm run server -- [--demo <fixture.json>] [--speed 1x|10x]';
let args;
try {
  args = parseArgs({ options: { demo: { type: 'string' }, speed: { type: 'string', default: '10x' } } });
} catch (err) {
  console.error(`${(err as Error).message}\n${USAGE}`);
  process.exit(1);
}
const { demo, speed: speedArg } = args.values;
const speed = Number(speedArg.replace(/x$/i, ''));
if (!(speed > 0) || !Number.isFinite(speed)) {
  console.error(`invalid --speed "${speedArg}"\n${USAGE}`);
  process.exit(1);
}

if (existsSync('.env')) process.loadEnvFile('.env');
const env = process.env;
if (env.ANTHROPIC_API_KEY === '') delete env.ANTHROPIC_API_KEY;

let llm;
try {
  llm = env.ANTHROPIC_API_KEY ? new ClaudeProvider() : undefined;
} catch (err) {
  if (!(err instanceof LlmConfigError)) throw err;
  console.error(err.message);
  process.exit(1);
}
const locale = LocaleSchema.parse(env.BATON_LOCALE || 'zh');
const workshop = env.BATON_WORKSHOP ? loadWorkshop(env.BATON_WORKSHOP) : undefined;
const zoom: ZoomCredentials | undefined =
  env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET && env.ZOOM_SECRET_TOKEN
    ? { clientId: env.ZOOM_CLIENT_ID, clientSecret: env.ZOOM_CLIENT_SECRET, secretToken: env.ZOOM_SECRET_TOKEN }
    : undefined;
const replay = demo ? loadReplay(demo) : undefined;

const baton = createBatonServer({
  zoom,
  devMeetings: replay ? ['demo'] : [],
  feedbackFile: env.BATON_FEEDBACK_FILE || 'data/feedback.jsonl',
  debugTranscript: env.BATON_DEBUG_TRANSCRIPT === '1',
  newSession: (meetingId) =>
    meetingId === 'demo' && replay
      ? new Session({ meetingId, locale: replay.fixture.locale, workshop: replay.workshop, llm, llmInBackground: true })
      : new Session({ meetingId, locale, workshop, llm, llmInBackground: true }),
});

const port = Number(env.PORT || 8080);
baton.server.listen(port, () => {
  console.log(`[baton] listening on http://localhost:${port}`);
  if (env.BATON_DEBUG_TRANSCRIPT === '1') console.log('[baton] transcript segment debug log: on (shape only, no text)');
  console.log(`[baton] Zoom webhook: ${zoom ? 'POST /webhook' : 'disabled (set ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / ZOOM_SECRET_TOKEN)'}`);
  console.log(`[baton] LLM tracking: ${llm ? 'on' : 'off (no ANTHROPIC_API_KEY)'}; Zoom meetings run as: ${workshop ? `workshop "${workshop.title}"` : 'meeting'}`);
  if (replay) {
    console.log(`[baton] demo (${replay.workshop ? `workshop "${replay.workshop.title}"` : 'meeting'}) at ${speed}x: open http://localhost:${port}/?meeting=demo`);
    // Give the browser a moment to connect; late joiners still get the replayed history.
    setTimeout(() => void baton.startMeeting('demo', new ReplaySource(replay.fixture, speed)), 3000);
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    baton.close();
    process.exit(0);
  });
}
