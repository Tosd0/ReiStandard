# `examples/agentic-loop-skeleton`

A protocol-neutral starting point for v0.7 `onLLMOutput`. The trigger
logic (`text.includes('NEED_TOOL')`, `text.startsWith('REFLECT_AGAIN')`)
is **intentionally stand-in** — replace it with whatever marker /
parser your business app actually uses (`[[TAG]]`, `tool_calls` JSON,
XML, natural-language classifier, …). The package itself ships no
parser; the hook is yours.

## Run locally (Cloudflare Workers)

```bash
npm install --save @rei-standard/amsg-instant
npx wrangler dev --local examples/agentic-loop-skeleton/worker.js
```

Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` via `wrangler secret put`.

## What it demonstrates

| Trigger                          | Hook decision         | What happens                                                  |
|----------------------------------|-----------------------|---------------------------------------------------------------|
| LLM output contains `NEED_TOOL`  | `tool-request`        | Push tool-request envelope, wait for SW to call `/continue`   |
| LLM output starts `REFLECT_AGAIN`| `continue`            | Worker runs another LLM round without pushing                 |
| Anything else                    | `finish`              | Push the v0.6 default 13-field payload and finish             |

## Where to take it next

- Replace the trigger with your real protocol parser.
- Swap `createMemoryBlobStore()` for `createD1BlobStore(env.DB, ...)`
  in production (Memory is per-isolate; SW fetches will miss across
  isolates).
- Wire the SW's `push` handler — see README §"SW routing" and
  §"sessionId dedup" for the dedup pattern.
