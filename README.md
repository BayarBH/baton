# Baton / Shikiri（仕切り）

AI meeting facilitator for Zoom: keeps the agenda and timebox, balances airtime, pushes for decisions, guards outcomes. It guides; humans decide.

Status: Phase 0–3 (replayer, workshop engine, LLM state tracking, Zoom RTMS + sidebar). Phase 3 still needs acceptance in a real meeting. See [CLAUDE.md](CLAUDE.md) for the full spec and roadmap.

```sh
npm install
npm test
npm run replay -- fixtures/transcripts/workshop-design-sprint.ja.json            # instant
npm run replay -- fixtures/transcripts/workshop-design-sprint.ja.json --speed 10x # paced
npm run replay -- fixtures/transcripts/meeting-weekly.zh.json --llm              # with Claude (.env)
```

Default language is Chinese (`zh`): meeting-mode nudges follow `BATON_LOCALE` (default `zh`), workshop mode follows the script's `locale` (`fixtures/workshops/design-sprint-lite.zh.json` is the Chinese Design Sprint; a Japanese one is alongside).

Fixture format: see `FixtureSchema` in `src/ingest/replay-source.ts` (`at` is `mm:ss`, `dur` is seconds).

## Sidebar demo (no Zoom needed, works on Windows)

```sh
npm run server -- --demo fixtures/transcripts/meeting-weekly.zh.json --speed 10x          # Chinese meeting
npm run server -- --demo fixtures/transcripts/workshop-design-sprint.ja.json --speed 10x # Japanese workshop
# open http://localhost:8080/?meeting=demo
```

## Running in a real Zoom meeting

The RTMS SDK (`@zoom/rtms`) ships for **linux-x64 and darwin-arm64 only**, so on Windows run the server inside WSL2 (or Docker); `npm install` there picks it up automatically.

1. Expose the server over HTTPS, e.g. `ngrok http 8080` → `https://<host>`.
2. In the [Zoom App Marketplace](https://marketplace.zoom.us/): Develop → Build App → General App (user-managed), then
   - **Home URL**: `https://<host>/`, and add `<host>` and `appssdk.zoom.us` to the **Domain Allow List**
   - **Surface**: in-meeting Zoom App; **Zoom App SDK** APIs: `getRunningContext`, `startRTMS`, `onRTMSStatusChange`
   - **Event Subscription**: RTMS events (`meeting.rtms_started`, `meeting.rtms_stopped`) to `https://<host>/webhook`
   - **Scopes**: search "rtms" and add the Meetings and RTMS scopes; optionally enable RTMS auto-start
3. Put the Client ID, Client Secret and the webhook Secret Token in `.env` (see `.env.example`), plus `BATON_WORKSHOP` for workshop mode.
4. `npm run server`, open the app in a meeting, press **Start** (or rely on auto-start). Nudges appear in the sidebar.

Server endpoints: `POST /webhook` (Zoom, signature-verified), `GET /` (home URL; issues a sidebar token for the meeting in the signed `X-Zoom-App-Context`), `GET /events` (SSE to the sidebar), `POST /next` (advance the workshop step).

Each nudge in the sidebar has **采纳 / 忽略** (adopted / ignored; 採用 / 無視 in Japanese) buttons. Verdicts are appended to `data/feedback.jsonl` (rule metadata only, never the nudge text); `npm run feedback` prints the adoption rate per rule.

First real-meeting check: set `BATON_DEBUG_TRANSCRIPT=1` to log each RTMS transcript segment's shape (timestamps, sizes, and whether it repeats/extends the previous segment from the same speaker) — never its text or the speaker name. `sameStart`/`extendsPrev` being true means Zoom sends interim revisions, which would double-count airtime.
