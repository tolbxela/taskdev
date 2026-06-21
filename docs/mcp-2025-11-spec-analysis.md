# MCP 2025-11-25 spec — full applicability review for TaskDev

Full review of the November 2025 MCP revision (every item in the official
changelog at `/specification/2025-11-25/changelog`) against TaskDev's
current MCP surface:

- Tools: `taskdev_control`, `taskdev_list`, `taskdev_status`, `taskdev_logs`,
  `taskdev_logs_history`, `taskdev_projects`, `taskdev_add`, `taskdev_remove`,
  `taskdev_restart`.
- Resources: `taskdev://logs/{project?}/{name}` resource template.
- Transport: stdio only (local spawn from the host).
- No auth, no elicitation, no sampling, no remote/HTTP transport.

## Headline conclusion

**No change in the 2025-11-25 revision justifies near-term work on
TaskDev.** Almost every major SEP either targets transports / features
TaskDev does not use (auth, elicitation, sampling, remote HTTP) or is so
fresh that no target client has shipped support yet (Tasks). A handful
of small, low-cost polish items are worth picking up opportunistically;
they are flagged below.

## Executive verdict table

| Change (SEP / source) | Area | Affects TaskDev? | Action |
| --- | --- | --- | --- |
| **Tasks extension** (SEP-1686 / SEP-2663) | Async tool calls | Semantic mismatch; no client support | **Defer.** Revisit when ≥1 target client ships it. New Tasks-shaped tools (`run_to_completion`, `wait_for_log`, `capture`) at that point. |
| **Pagination** (spec core) | List endpoints only | Doesn't reach our logs (tool result + `resources/read`); our lists are tiny | **No-op.** |
| OIDC Discovery for auth servers (PR #797) | Authorization | No auth; stdio local | **N/A.** |
| Icons metadata (SEP-973) | Tool/resource/prompt metadata | We could expose icons | **Optional polish.** Tiny effort; nicer UX in hosts that render icons. |
| Incremental scope consent (SEP-835) | OAuth `WWW-Authenticate` | No auth | **N/A.** |
| Tool name guidance (SEP-986) | Naming convention | Our names already conform (`taskdev_*`, snake_case, ≤64 chars) | **No-op; confirmed compliant.** |
| `ElicitResult` / `EnumSchema` rework (SEP-1330) | Elicitation | No elicitation today | **N/A.** Only relevant if we add interactive prompts. |
| URL mode elicitation (SEP-1036) | Elicitation | No elicitation today | **N/A.** |
| Sampling with tools (SEP-1577) | Sampling | We don't sample | **N/A.** |
| OAuth Client ID Metadata Documents (SEP-991) | Authorization | No auth | **N/A.** |
| stderr logging clarified for stdio (PR #670) | stdio transport | We already log to stderr | **No-op; already compliant.** |
| Optional `Implementation.description` | Server metadata | Trivial improvement | **Optional polish.** One-line edit in `mcp.mjs`. |
| HTTP 403 for invalid `Origin` (PR #1439) | Streamable HTTP | stdio only | **N/A.** |
| Updated Security Best Practices | Guidance | Local stdio, no tokens, no external endpoints | **Review once; expected no-op.** |
| Tool validation errors → exec errors (SEP-1303) | Error reporting | We throw inside tool handlers | **Verify SDK behaviour.** Likely already correct via the TypeScript SDK; worth a 10-minute audit. |
| SSE polling via server disconnect (SEP-1699 + clarifications) | Streamable HTTP | stdio only | **N/A.** |
| OAuth 2.0 PRM aligned with RFC 9728 (SEP-985) | Authorization | No auth | **N/A.** |
| Default values for elicitation primitives (SEP-1034) | Elicitation | No elicitation | **N/A.** |
| JSON Schema 2020-12 default dialect (SEP-1613) | Schemas | We use the TS SDK's zod adapter | **Track SDK upgrade.** SDK handles the dialect declaration. |
| RPC payloads decoupled from method defs (SEP-1319) | Schema housekeeping | Internal to spec/SDK | **No-op for us.** |
| Tool `inputSchema` / `outputSchema` JSON Schema 2020-12 (SEP-2106) | Tool schemas | Lets us return arrays / use composition keywords if we want | **Optional; nothing forces a change.** |

Two items account for almost everything anyone is likely to ask about
(Tasks and Pagination) and are treated in depth below. The rest are
summarised in *Section 3 – Per-change applicability*.

---

## 1. The Tasks extension (SEP-2663)

Spec source: `https://modelcontextprotocol.io/extensions/tasks/overview`
SEP: `https://modelcontextprotocol.io/seps/2663-tasks-extension` (Final,
Extensions Track, created 2026-04-27).

### What it is

An async-RPC handle. Instead of blocking on a long tool call, the server
returns `CreateTaskResult { taskId, status, ttlMs, pollIntervalMs }`. The
client polls `tasks/get` until the task reaches `completed` / `failed` /
`cancelled`. Mid-flight elicitation goes through `tasks/update`. Cancellation
via `tasks/cancel` is cooperative.

Negotiation is per-request, via
`_meta.io.modelcontextprotocol/clientCapabilities.extensions["io.modelcontextprotocol/tasks"]`,
matched by the server advertising the same extension.

### Client support today

The official extension support matrix at `/extensions/client-matrix`
tracks three extensions (MCP Apps, OAuth Client Credentials,
Enterprise-Managed Authorization). **Tasks is not yet a column** — too
new. A web search for production Tasks implementations in Claude
Desktop / Cursor / Windsurf / Copilot returned nothing concrete; only
the spec page itself surfaces. The TypeScript SDK
(`@modelcontextprotocol/sdk`) does not appear to ship task-extension
helpers yet either.

For TaskDev's actual user base (Cascade, Claude Code, Cursor, Codex),
shipping Tasks support today would mean no agent ever opts in, and the
server-side plumbing would be dead code.

### Semantic mismatch with TaskDev

| Concept | MCP Tasks | TaskDev's user-defined tasks |
| --- | --- | --- |
| Lifecycle | One RPC that completes once. | Long-running dev process; user starts/stops. |
| Terminal state | `completed` with `result`. | None — `npm run dev` runs until killed. |
| Polling cadence | Client polls `pollIntervalMs` until done. | Extension reconciles every 10s; logs stream continuously. |
| Cancellation | Best-effort `tasks/cancel`. | Imperative `taskdev_control(stop)` — must work. |
| Ownership | LLM-initiated, LLM-tracked. | User-initiated, user-owned; LLM is one of several observers. |

Mapping `taskdev_control(start, name)` onto a Task forces the model
"this RPC is taking a while". But the call already returns immediately
with `{ pid, logPath }`. The work isn't blocking the call — the *task
itself* is what runs indefinitely, and its lifecycle is owned by the
human developer, not the LLM. Bolting on Tasks adds polling and
capability negotiation overhead without changing what the agent gets.

### Where Tasks *would* be a natural fit (new tools, deferred)

Three operations TaskDev does not have today, each with a real
completion event, that would be textbook MCP-Tasks shape:

- **`taskdev_run_to_completion({ name, timeoutMs? })`** — for tasks
  expected to exit (build, test, lint, migration). Task completes on
  child exit. Result includes `exitCode` and the log tail.
- **`taskdev_wait_for_log({ name, pattern, timeoutMs? })`** — task
  completes when `pattern` (regex) appears in the named task's log, or
  on timeout. Returns the matching line and context. Useful for "wait
  until `Listening on :3000` before continuing."
- **`taskdev_capture({ name, durationMs })`** — start the task,
  capture output for N ms, return the chunk, stop the task.

Recommendation: **do not implement these until at least one target
client (Cascade, Claude Code, Cursor) ships Tasks support.** The tools
are valuable independently; gating them behind Tasks before any client
supports the negotiation would waste the work.

### DRY structure if/when they get added

The codebase is already cleanly layered:

```
core.cjs            single source of truth (start/stop/list/tailLog/listLogs)
extension.js        VS Code UI; calls core.*
mcp.mjs             MCP tool handlers; calls core.*
test/core.test.cjs  exercises core.*
```

A Tasks layer would slot in alongside the existing tools without
touching `core.cjs`:

```
mcp.mjs
  tools/  (existing sync tools — unchanged)
  task_runtime.mjs  (NEW, only when Tasks ships)
    - Map<taskId, { state, promise, abortCtl, result, error, createdAt, ttlMs }>
    - tasks/get, tasks/update, tasks/cancel, tasks/list handlers
    - run_to_completion / wait_for_log / capture
        implemented as orchestrations over core.start / tailLog / stop
```

The Tasks layer is state, lifecycle, and JSON-RPC plumbing only. All
real work flows through the same `core.cjs` functions the existing
tools use. No duplication, no drift.

---

## 2. Pagination on the logs surface

Spec source: `https://modelcontextprotocol.io/specification/...#pagination`.

### What the spec says (and doesn't say)

Pagination is **opaque cursor-based** and applies to a fixed set of
list endpoints:

- `resources/list`
- `resources/templates/list`
- `prompts/list`
- `tools/list`

Crucially, it does **not** apply to:

- Tool call results (so `taskdev_logs` cannot use the spec mechanism
  directly).
- `resources/read` (returns a single blob; no `nextCursor` is defined).

So "use MCP pagination for the logs" is not literally available. The
only literal application would be paginating our own
`tools/list` / `resources/list` responses, which is moot — TaskDev has
~7 tools and a handful of resources.

### What `taskdev_logs` already does (0.1.20)

- Default 32 KB tail of the most recent run; `bytes` parameter up to
  128 KB.
- Prepends a one-line header
  `[taskdev: showing last X of Y bytes; raise bytes or read
  taskdev_logs_history.path directly]` when truncated.
- Returns the absolute log `path` and `taskdev_logs_history` returns
  per-run paths.

### Why a tool-native cursor probably isn't a real win

Every realistic TaskDev client today runs over **stdio on the same
filesystem** as the MCP server: Cascade, Claude Code, Cursor, Codex.
All of them ship a native file-read tool that can open any path the
MCP server hands them. That path is already the documented escape
hatch when 32 KB isn't enough, and it dominates a tool-side cursor:

- Random access (line ranges, regex, head / middle / tail) instead of
  walking opaque cursors backward.
- Token cost paid once, not amortised across multiple paged calls
  with header overhead on each.
- The agent can grep server-side via its own shell; we don't have to
  reinvent that.

A tool-native cursor on `taskdev_logs` would only matter when **all**
of:

1. The transport is remote MCP (no shared filesystem).
2. The agent has no file-read tool of its own.
3. The agent specifically wants middle-of-file content served by us.

TaskDev is stdio-local, dev-focused, and every target client violates
(2). The cursor is API surface chasing a problem we don't have.

### `taskdev_logs_history` pagination

Marginal value. The list is already capped at "newest first" with a
sensible default. Only meaningful when a single task has hundreds of
historical runs (CI, long-lived daemons). Not worth doing pre-emptively.

### What *would* improve the log surface

Honest list of alternatives, in rough order of expected payoff:

| Idea | Real win? | Notes |
| --- | --- | --- |
| Cursor pagination on `taskdev_logs` | **No** | Agents already have the path + a native read tool. |
| Cursor pagination on `taskdev_logs_history` | **Marginal** | Only relevant past ~100 historical runs per task. |
| `taskdev_logs` filter param (`match`, `since`, `until`) | **Possibly** | Server-side grep, returns matches with line numbers. Cheaper than paging chunks. Duplicates what agents do natively. |
| `taskdev_logs` time-range param | **Marginal** | Requires lines to be timestamped, which TaskDev does not enforce. |
| Tasks-shaped `wait_for_log` | **Yes — later** | New capability; depends on Tasks client support. |
| Tasks-shaped `run_to_completion` | **Yes — later** | Same. |
| Tasks-shaped `capture` | **Yes — later** | Same. |

---

## 3. Per-change applicability (everything else in the changelog)

The two sections above cover the items the user explicitly asked about.
This section walks the remaining entries from
`/specification/2025-11-25/changelog` so the review is complete. Items
are grouped by area and tagged with one of: **N/A** (does not touch
TaskDev), **No-op** (already compliant), **Polish** (optional minor
improvement), or **Verify** (cheap audit recommended).

### 3.1 Authorization (all **N/A**)

TaskDev is a local stdio extension. There are no tokens, no remote
endpoints, no IdPs. None of the auth changes apply.

- **OIDC Discovery for authorization servers** (PR #797).
- **Incremental scope consent via `WWW-Authenticate`** (SEP-835).
- **OAuth Client ID Metadata Documents** (SEP-991).
- **OAuth 2.0 Protected Resource Metadata aligned with RFC 9728**
  (SEP-985).

If TaskDev ever grows a remote bridge (e.g. a hosted MCP variant), all
of these become relevant in one bundle. Until then, no work.

### 3.2 Elicitation (all **N/A** unless we add prompts)

TaskDev does not call `elicitation/create` today. The user-facing
prompt in the extension itself (the "Install MCP config" pick) is a VS
Code UI prompt, not an MCP elicitation. The following only matter if a
future feature lets the agent ask the user for input through the MCP
channel (unlikely — the agent already has its own chat surface).

- **URL mode elicitation** (SEP-1036).
- **`ElicitResult` / `EnumSchema` rework** (SEP-1330).
- **Default values for elicitation primitives** (SEP-1034).

If we add a tool that genuinely needs structured user input (e.g. "pick
which `taskdev.json` to add to"), elicitation becomes worth a fresh
look, including the new URL mode for any sensitive picks.

### 3.3 Sampling (**N/A**)

- **Sampling with tools** (SEP-1577).

Sampling is the *server* asking the *client* to run a model. TaskDev
has no use case for delegating model calls back to the host. N/A.

### 3.4 Streamable HTTP transport (all **N/A**)

- **HTTP 403 for invalid `Origin`** (PR #1439).
- **SSE polling via server-side disconnect** (SEP-1699 + clarifications).

TaskDev only speaks stdio. These changes would only matter if we ever
exposed an HTTP MCP endpoint (which has no compelling driver — every
target client connects locally via stdio against `dist/mcp.mjs`).

### 3.5 Tool naming (SEP-986, **No-op**)

The guidance recommends names that are short, snake_case, prefixed with
a server identifier, and ≤64 characters. TaskDev's tools already
satisfy this: `taskdev_control`, `taskdev_list`, `taskdev_status`,
`taskdev_logs`, `taskdev_logs_history`, `taskdev_projects`,
`taskdev_add`, `taskdev_remove`, `taskdev_restart`. No rename needed.

### 3.6 Icons metadata (SEP-973, **Polish**)

Servers may now expose icons for tools, resources, resource templates,
and prompts via a new `icons` field. Hosts can render these next to the
tool name (e.g. in agent pickers or audit logs).

TaskDev already ships an icon (`media/icon.png`). Cost is one extra
field per tool registration, e.g. all of them pointing at the same
brand icon URL or data URI. Pure cosmetic; pick up next time the tool
registration block is touched.

### 3.7 Optional `Implementation.description` (**Polish**)

The `Implementation` object (sent in `initialize`) gains an optional
`description` field that hosts may surface during initialization. Today
TaskDev only sends `{ name, version }`. Adding `description: "Run and
observe long-running developer tasks (dev servers, watchers,
migrations) from the agent."` is a one-line improvement.

### 3.8 stderr logging clarification for stdio (PR #670, **No-op**)

The spec now explicitly allows stdio servers to write *any* log level
to stderr, not just errors. The TypeScript SDK already routes
diagnostics to stderr and TaskDev never writes diagnostic output to
stdout (which is reserved for JSON-RPC framing). Confirmed compliant.

### 3.9 Tool input validation errors → tool execution errors (SEP-1303, **Verify**)

The clarification: when a tool call has invalid arguments, return a
**tool execution error** (i.e., a successful JSON-RPC response with
`isError: true` in the result) rather than a JSON-RPC **protocol
error**. Reason: lets the model self-correct from the next turn.

TaskDev tool handlers do `throw new Error(...)` on bad input
(`invalid task name`, `unknown project`, etc.) and rely on the
TypeScript SDK to translate the throw into the wire response. The
SDK's current behaviour is to wrap thrown errors as tool execution
errors with `isError: true`, which matches SEP-1303. Cheap to confirm
by inspecting one error path against the MCP Inspector — recommended
when the SDK is next bumped.

### 3.10 Security Best Practices update (**Review**)

Updated guidance at `/specification/2025-11-25/basic/security_best_practices`.
Most attacks (confused deputy, token passthrough, SSRF, session
hijacking) are HTTP-transport concerns. The local-server compromise
section and scope minimisation guidance apply to TaskDev: stdio servers
must treat command arguments and environment as untrusted input. We
already validate task names via `TASK_NAME_RE` and resolve log paths
under the project root only. Recommended action: read the update once,
confirm no new mitigations apply.

### 3.11 JSON Schema 2020-12 (SEP-1613 + SEP-2106, **Track SDK**)

- **SEP-1613**: 2020-12 is the new default dialect for all MCP schemas.
- **SEP-2106**: `inputSchema` / `outputSchema` / `structuredContent` on
  tools must conform to 2020-12 (allows arrays at the top level,
  composition keywords like `oneOf`, etc.).

TaskDev declares tool schemas with zod, which the TypeScript SDK
serialises to JSON Schema. Both the dialect URI and the
`structuredContent` shape are SDK concerns. Action: when the next
`@modelcontextprotocol/sdk` version that explicitly advertises 2020-12
ships, bump the dep and rebuild — that is the only thing TaskDev needs
to do.

### 3.12 RPC payloads decoupled from method definitions (SEP-1319, **No-op for us**)

This is a schema-housekeeping change: methods like `tools/call` are now
defined by referencing a standalone parameters schema instead of
inlining it. Pure SDK / spec-internal refactor; downstream servers like
TaskDev see no surface change.

---

## 4. Recommendation

Short version:

- **Don't migrate existing tools to Tasks.** Wrong abstraction. No
  client support.
- **Don't add cursor pagination to `taskdev_logs` right now.** The
  "tell the agent the path" pattern is already simpler and better for
  every current client.
- **Watch the extension support matrix** at
  `/extensions/client-matrix` and the SDK changelog for Tasks adoption.
  When a target client ships support, revisit
  `taskdev_run_to_completion`, `taskdev_wait_for_log`, and
  `taskdev_capture` as Tasks-shaped tools layered over `core.cjs`.
- **If the logs surface gets revisited**, a `match` filter is a more
  honest improvement than pagination — but only if the workflow demands
  it. Today the `path + agent's native file tool` pattern is fine.
- **Pick up the polish items opportunistically** (icons on tools,
  `Implementation.description`, an SEP-1303 audit pass) next time the
  MCP server block in `mcp.mjs` is open for another reason. Not worth
  a dedicated PR.

The current MCP surface is small, predictable, and aligned with how the
clients actually consume it. No spec-driven change is justified by the
2025-11-25 revision alone.
