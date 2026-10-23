# Source notices

DSH Remote WeCom is distributed under the [MIT License](LICENSE), copyright 2026 Luke.

## Included source

- `lib/core/` (session engine, commands, cards, WeCom transport, configuration, directory aliases and artifact filtering) was adapted from pi-remote-wecom `0.3.17`, revision `0013e4a09529604fdd63bcd00a3e4a8936e5cb7d`, also copyright 2026 Luke under MIT. Its own included-source notices (pi-remote, pi-tab-title) apply to the parts carried over; the tab-title module itself is not included here.

## Dependencies

The WeCom transport uses the official [@wecom/aibot-node-sdk](https://github.com/WecomTeam/aibot-node-sdk), installed as a dependency. DeepSeek Harness modules are supplied by the host at runtime; `@deepseek-ai/dsh` is a development dependency used only by the end-to-end test. Dependency packages retain their own licenses; see their installed package contents and the lockfile metadata.
