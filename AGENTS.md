# AGENTS.md

DeepSeek Harness (DSH) bundle plugin that lets the owner drive Desktop sessions from a WeCom smart bot. User-facing behavior is in [README.md](README.md); host interfaces, event shapes and design decisions are in [docs/DESIGN.md](docs/DESIGN.md). Read both before changing behavior.

## Layout

| Path | Responsibility |
|---|---|
| `lib/index.mjs` | Plugin entry: config watch, remote instance lifecycle, settings RPC registration |
| `lib/core/` | Host-independent layer adapted from pi-remote-wecom: commands, cards, run/target state, push and quote routing, WeCom transport, config, aliases, artifacts, QR auth, watchdog |
| `lib/host/dsh-host.mjs` | DSH adapter: session controller calls, `session/event` translation, approval and question waterfalls |
| `lib/host/settings-rpc.mjs` | Backend of the Desktop "企微远程" settings page |
| `lib/core/launchd.mjs` | launchd registration of the offline watchdog, shared by the settings switch and the CLI |
| `client/` | Settings page front end, bundled to `dist/client.js` by `npm run build` |
| `bin/dsh-remote.mjs` | CLI: `setup`, `bind`, `status`, `alias`, `watchdog` |
| `scripts/preview.mjs` | Settings page preview on an isolated DSH web instance with fake WeCom and QR endpoints |
| `scripts/check-public.mjs` | Release guard for internal links, local paths and package metadata |

## Commands

```sh
npm install
npm run check         # build + syntax check of every source file + unit tests
npm run test:e2e      # isolated dsh --profile web with fake LLM, WeCom and QR endpoints (~30 s)
npm run check:public  # before any push to GitHub or npm publish
```

## Rules

- Never touch the real `~/.dsh` or a real bot from tests; use the fixtures in `tests/fixtures/` and a temporary `DSH_HOME`.
- Secrets never leave `config.json`: no RPC response, log line or CLI output may contain the Secret; BotID and owner ids are masked.
- One bot allows one long connection. Do not add code paths that connect while the plugin heartbeat is fresh.
- Command names, Chinese aliases and card layouts follow pi-remote-wecom; change them only on purpose and update the README tables.
- `dist/` is built, not committed; `npm publish` builds it through `prepublishOnly`.
- New behavior gets a unit test in `tests/unit/`; host-facing changes also run `npm run test:e2e`.
- Do not commit secrets, real user ids, internal links or local absolute paths; `npm run check:public` enforces the common cases.
