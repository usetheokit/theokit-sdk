# `@theokit/sdk` — `internal/agent-loop/`

The agent-loop subsystem orchestrates per-turn LLM calls, tool dispatch, message-history construction, and usage/cost accounting for `LocalAgent.send()` and friends.

## Files

| File | Responsibility |
|---|---|
| `loop.ts` | `runAgentLoop` — the main per-turn orchestrator (LLM call → tool dispatch → message append → next turn check) |
| `loop-types.ts` | Shared types: `LoopContext`, `LoopOutcome`, `LoopHooks` |
| `message-builders.ts` | Builds outbound message arrays from `Conversation` state per provider format |
| `tool-dispatch.ts` | `dispatchSingleCall` — tool-call validation, execution, error wrapping (ADR D86-D89) |
| `usage-and-cost.ts` | Accumulates token usage + budget evidence (ADR D375-D388) |

## Auditor-acknowledged orchestrators (info-level)

The 2026-06-06 architecture audit (`/loop-architecture-review` Phase 3 principles-auditor) flagged one item in this folder at **INFO severity** — auditor-noted, not actionable as a fix:

- **PV#3 — `runAgentLoop` in `loop.ts:33` is ~65 LOC orchestrator with biome-ignore for cognitive complexity.** 65 LOC is above the SonarQube / arch-go 50 LOC default function budget but well below the 500 LOC file budget and below McCabe CC ≤ 10. The function is a sequential orchestration of a closed sequence (LLM call → response parse → tool dispatch → message append → next-turn check) — splitting would harm KISS by forcing the same sequence to be reassembled at the call site, which only `LocalAgent.send` exercises. The existing `biome-ignore lint/complexity/noExcessiveCognitiveComplexity` annotation acknowledges the trade-off explicitly.

Plan `arch-review-fixes-2026-06-06` T11.2 records this trade-off. Audit DB row `principle_violations.id=3` @ `packages/sdk/src/internal/agent-loop/loop.ts:33`; report at `architecture-output/final_report.md § Findings by dimension` PV#3.

## Related ADRs

- D86 — `internal/tool-dispatch/` module home (Repair + strip-think + dispatch)
- D87 — repair sequence (3 idempotent passes)
- D88 — NO fuzzy tool-name matching
- D89 — tool errors return as `tool_result isError: true`, never throw
- D375-D388 — Budget USD-grade accounting wired through `usage-and-cost.ts`

## MCP names and forced calls

The model sees MCP tools through `mcpModelToolName` in `loop-context-init.ts`, the single place names are built. The mapping is injective: a plain server (`[A-Za-z0-9-]+`) with a plain tool (`[A-Za-z0-9_-]+`) becomes `mcp_<server>_<tool>`; any other pair becomes `mcp__<readable>_<128-bit hash of [server, tool]>`. The two forms cannot overlap, so a filtered-out tool's name never equals an offered tool's. Execution uses the server's original names carried on the resolved tool, so the sanitized name is never sent to a server.

The catalog built from each client's `listTools` — already narrowed by any MCP tool filter — is the only dispatch authority. A call (including a forced one) whose name is not in the catalog is refused with an `Unknown tool` error and never reaches `callTool`. Because sanitizing can produce names differing only in case, `tool-dispatch.ts` never case-repairs `mcp_` names or ambiguous matches, so a filtered-out tool cannot be silently redirected to a different offered one.
