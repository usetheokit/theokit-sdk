---
'@theokit/sdk': minor
---

The protected-path and critical-path floors now fire from the runtime, before the permission engine
and before the consumer's `canUseTool` gate.

They did not. `permission-floors.ts` was imported by `src/index.ts` and by nothing else, so a tier
whose own documentation says it sits "above every permission rule and every mode" was consulted only
if a consumer remembered to call `permissionFloorReason` themselves. A guarantee that depends on
being remembered is as strong as the memory, which is the failure this slice was written to remove.

`permission-plugin.ts` — the `pre_tool_call` decision point — now asks the floor FIRST. An `allow`
rule, an allowing gate and `permissionMode: "bypassPermissions"` together no longer reach a write
into `.claude/` or `.theokit/`, nor a destructive operation on a critical root. `bypassPermissions`
not reaching the floor is deliberate: a mode that skips it is a mode that can rewrite the policy
meant to bound it.

The `@theokit/sdk` bundle budget moves 27000 → 28000 gzipped as a direct consequence: the runtime
now carries a security tier it did not carry before (27338, 98% of the new ceiling). The headroom is
662 bytes, so unintended growth still trips the gate.
