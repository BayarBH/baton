# Baton / Shikiri（仕切り）

AI meeting facilitator for Zoom: keeps the agenda and timebox, balances airtime, pushes for decisions, guards outcomes. It guides; humans decide.

Status: Phase 0–2 (replayer, workshop engine, LLM state tracking). `--llm` on replay uses Claude (needs `ANTHROPIC_API_KEY` + `BATON_LLM_MODEL` in `.env`). See [CLAUDE.md](CLAUDE.md) for the full spec and roadmap.

```sh
npm install
npm test
npm run replay -- fixtures/transcripts/workshop-design-sprint.ja.json            # instant
npm run replay -- fixtures/transcripts/workshop-design-sprint.ja.json --speed 10x # paced
```

Fixture format: see `FixtureSchema` in `src/ingest/replay-source.ts` (`at` is `mm:ss`, `dur` is seconds).
