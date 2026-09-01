# Fixtures

Real recordings of `dext --output stream-json` runs (dext 0.1.0, kimi/k3), captured 2026-09-01 in a scratch project. Thinking deltas are downsampled (first 12 kept) to keep the repo lean; every other event is byte-original, including key order.

- `text.raw.jsonl` — pure text turn with thinking (57 lines).
- `tool.raw.jsonl` — one bash tool call: preview → start → result, plus `external_telemetry` (28 lines).

These pin the event shapes for `packages/protocol`, drive the mock server's replay sessions, and serve as the conformance baseline for `agentlinkd` (the Rust host) and the `dext bridge` upstream PR.

Regenerate with:

```bash
cd /tmp/scratch && dext --output stream-json --no-session --approval always "<prompt>" > out.raw.jsonl
```
