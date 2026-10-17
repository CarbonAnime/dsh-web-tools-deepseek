## What changed

<!-- One or two sentences. Link the issue this closes: "Closes #12". -->

## Why

<!-- The problem this solves, or the invariant it protects. -->

## Which surface

- [ ] Rust engine (`crates/engine/`)
- [ ] JS bridge (`lib/`)
- [ ] Tests (`test/`)
- [ ] CI / packaging (`.github/`, `scripts/`)
- [ ] Documentation (`README.md`, `README.zh-CN.md`, `SECURITY.md`)

## Verification

<!-- Paste what you actually ran. -->

```
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
npm run build:engine          # or: cargo build --release && node scripts/stage-engine.mjs
npm test
```

- [ ] `npm test` passes (engine contract + unit + live smoke — the smoke suite spends real API credit)
- [ ] CI is expected to stay green on all four targets (`win32-x64`, `linux-x64`, `darwin-arm64`, `darwin-x64`)

## Contract notes

<!-- If you touched either provider: does the wire payload still match
`POST /v1/tools/search` / `POST /v1/tools/fetch` in the official docs? A non-2xx
API response must still come back as a *result*, never as a throw. If you
changed the diagnostics format, say so — people grep that file. -->

## Checklist

- [ ] No new runtime dependencies without a note in the PR body
- [ ] Both READMEs updated for user-facing changes
- [ ] No secrets, tokens, or private URLs in the diff or in test fixtures
- [ ] A config change does not need a DSH restart; a code change does (ESM modules are cached)
