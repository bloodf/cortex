# @cortexos/opencode-hindsight-plugin

OpenCode event-hook plugin that automatically retains assistant turns into a
self-hosted [Hindsight](https://github.com/vectorize-io/hindsight) instance and
recalls relevant memories when a session is compacting.

Each directory gets its own Hindsight bank (`dir-<slug>-<hash>`), mirroring the
`@cortexos/hindsight-memory-mcp` package's bank derivation so both wirings share
the same per-project memory.

## Events handled

- `message.updated` — on assistant turn completion, retain the user+assistant
  exchange into the current directory's Hindsight bank.
- `experimental.session.compacting` — before OpenCode compacts a session, recall
  relevant memories from the bank and log them for context.

If the installed OpenCode version does not emit `experimental.session.compacting`,
retain-only behavior remains active; recall is then driven by the MCP tools
(`hindsight_recall_memory`, `hindsight_reflect_memory`).

## Configuration

Environment variables:

| Variable                | Default                  | Description                              |
| ----------------------- | ------------------------ | ---------------------------------------- |
| `HINDSIGHT_API_URL`     | `http://127.0.0.1:8888`  | Hindsight API base URL.                  |
| `HINDSIGHT_API_KEY`     | `undefined`              | Optional API key (bearer).               |
| `CORTEX_HINDSIGHT_CWD`  | `process.cwd()`          | Directory used to derive the bank id.    |

## Build

```bash
pnpm --filter @cortexos/opencode-hindsight-plugin build
```

## Registration

Add to `~/.config/opencode/opencode.json` per OpenCode's plugin loader
documentation:

```json
{
  "plugins": [
    "/opt/cortex/packages/opencode-hindsight-plugin/dist/index.js"
  ]
}
```

The example uses the default install root. For a custom `CORTEX_ROOT`, replace
`/opt/cortex` with its absolute value; JSON does not expand environment variables.
Configure the Hindsight endpoint and optional credentials in the environment
of the OpenCode process.
