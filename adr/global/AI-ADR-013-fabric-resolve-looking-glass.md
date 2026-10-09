# AI-ADR-013: fabric.resolve — a Read-Only Capability Looking Glass in fabric-ctrl

**Status:** Proposed  
**Date:** 2026-10-08  
**Author:** Ryan / ry-ops.dev  
**Scope:** Global — fabric-ctrl, gateway, sdk, and every fabric app  
**Depends On:** AI-ADR-012 (Agent Classification Taxonomy), ADR-010 (MCP vs Skills — Trust Boundary)  
**Schema:** [`fabric-ctrl/src/resolve/schema.ts`](https://github.com/git-fabric/fabric-ctrl/blob/main/src/resolve/schema.ts)

---

## Context

MCP clients already aggregate tools across every connected server, and the model
orchestrates across them. Multi-server work "just works" on the desktop, so building
a general-purpose MCP/LLM gateway platform would duplicate what clients give us for free.

What clients do **not** give us:

1. **Awareness before action.** Claude can only discover what the fabric can do by
   loading every tool description (100+ across ten apps), which costs context and
   degrades tool selection.
2. **Gap visibility.** When nothing can satisfy a request, the failure is silent or
   improvised. We learn nothing about what to build next.
3. **Health and scope truth.** A tool existing in `tools/list` does not mean its app
   is up or its token can write.
4. **Headless consumers.** git-steer, pipelines and Actions have no desktop client
   doing aggregation for them.

In BGP terms we have forwarding but no **looking glass**: a way to query the routing
table without sending traffic.

Two different components are both called "gateway" today, and this ADR names them
explicitly:

| Component | What it is | Used by |
|---|---|---|
| `@git-fabric/gateway` | In-process app registry (`FabricApp`, `FabricTool`, `health()`) plus a keyword MoE router | fabric-ctrl, loaded from `gateway.yaml` |
| `@fabric-sdk/gateway` | HTTP route reflector: F-RIB, `/register`, `/advertise`, `/withdraw`, keepalives, TTLs | Remote fabrics; not yet deployed |

## Decision

fabric-ctrl exposes **one read-only MCP tool, `fabric.resolve(intent)`** (MCP name `fabric_resolve`), that answers
three questions about any intent:

| Answer | Meaning |
|---|---|
| **have** | Every step of the plan can run: tools exist, apps are up, nothing is denied. |
| **partial** | A plan exists, but some steps are blocked or something else is missing. |
| **missing** | No plan exists, or every step of it is blocked (down, under-scoped, or denied). |

Each answer carries the ordered plan (steps, dependencies, read/write effect, health,
scope) and a typed list of gaps.

### Rules

1. **Advise, never execute.** `resolve` has no side effects. Execution stays with the
   caller (Claude, AIANA, git-steer) through the existing paths. `resolve` becomes the
   planning half of fabric-invoke: `invoke` with `dry_run: true` returns the `resolve`
   output, and `invoke`'s execution path is unchanged.
2. **Live inventory only.** No hand-maintained manifest.
   - **Phase 1:** the inventory is read from the `@git-fabric/gateway` registry that
     fabric-ctrl already loads: each app's `tools` and `health()`, refreshed on a fixed
     interval. It is held in memory; no Redis.
   - **Phase 2:** once `@fabric-sdk/gateway` is deployed, fabric-ctrl also consumes F-RIB
     advertise/withdraw events so remote fabrics appear in the same inventory
     (`origin: "frib"`).
   - Records past their TTL are reported as `health: unknown` with a `stale_inventory` gap.
3. **Effect comes from tool annotations.** `FabricTool` in `@git-fabric/gateway` gains an
   optional `annotations` field with the MCP hints (`readOnlyHint`, `destructiveHint`,
   `idempotentHint`, `openWorldHint`), passed through to `tools/list`. A tool without
   annotations is treated as `write` and its step is marked `effectSource: "default"`.
4. **Health and scope are part of the answer.** Each step carries app health (mapped from
   `HealthStatus`) and whether the fabric's credential covers the tool. A tool with no
   declared `requiredScopes` reports `scope: unknown`, which lowers confidence for write
   steps but does not block them.
5. **Matching may be fuzzy; everything after it is deterministic.**
   - Intent→tool candidates come from a pluggable matcher: lexical (BM25 over tool names
     and descriptions) in phase 1, Qdrant embeddings once Qdrant is deployed. The output
     says which matcher ran.
   - Plan ordering never uses a model. In order of preference:
     1. a **sequence template** (the existing `SEQ-01…06`, rewritten from agent-level to
        tool-level steps) whose trigger matches the intent;
     2. otherwise the matcher's **set cover**: the fewest tools that together cover the
        intent (a single step when one tool suffices), grouped by app with **reads before
        writes**, each write depending on the reads before it in the same app. The match
        threshold applies to the whole plan's coverage, not to each tool.
   - Anything that needs real multi-step chaining beyond that is returned as `partial`
     with a `low_confidence` gap and `escalation.recommended: "claude"`.
   - Verdict, confidence and gap classification are pure functions in the schema module.
6. **Every blocked step has a gap.** The plan builder emits a step-bound gap for each step
   that cannot run (app down or unknown, scope insufficient, policy denied, or a write
   under the `readOnly` constraint). The verdict follows from the gaps alone.
7. **Gaps become backlog.** Every gap may carry a typed suggestion (`build_app`,
   `add_model`, `grant_scope`, `restore_app`, `improve_description`). Its signature is a
   hash of `kind + target` only, so differently worded intents that hit the same gap group
   together. When one signature recurs N times in a window, it is surfaced to git-steer
   as an issue draft, never auto-filed silently.
8. **Identity comes from the connection.** `resolve` takes no `caller` argument;
   fabric-ctrl derives the caller from the MCP session or GitHub App installation, since
   `policy_denied` depends on it.
9. **Local first.** `resolve` reports whether each hop has a local fabric-llm route
   (`MODEL_REGISTRY` names, e.g. `unifi-ops`) and recommends `local`, `claude` or `none`.

## Consequences

**Positive**
- Claude calls one tool instead of loading the full tool catalog.
- Read-only design sidesteps cross-server trust risk; it cannot be used to act.
- Unresolved intents turn into a prioritized build list for new fabric apps and models.
- Headless consumers get the same awareness as a desktop client.
- Phase 1 needs no new infrastructure: the registry, health checks and sequences already
  exist in fabric-ctrl.

**Negative / risks**
- A confidently wrong `have` is worse than no answer. Mitigated by live inventory, TTLs,
  and a `confidence` field the caller must respect (below 0.6 is advisory only).
- Until apps are annotated, most steps default to `write`. Plans stay correct but
  conservative, and `readOnly` requests return mostly `policy_denied`.
- Lexical matching misses tools with poor names or descriptions. Description quality and
  annotations become `fabric-review` checks.
- Sequence templates must be maintained as tool names change; a template step whose tool
  is absent from the inventory produces a `no_tool` gap rather than failing silently.

## Alternatives considered

| Option | Why not |
|---|---|
| Adopt Bifrost / LiteLLM as the center | Duplicates sdk routing; doesn't answer "what's missing." |
| n8n as router | Static wiring flattens BGP-style runtime routing; not Git-native. |
| Do nothing (client aggregation) | Fine for desktop, but no gap visibility, no health/scope truth, no headless support. |
| `resolve` that also executes | Turns a looking glass into a second gateway and reintroduces cross-server trust risk. |
| Model-assembled plans (fabric-router) | Non-deterministic; the same inventory could yield different answers. Kept only as `invoke`'s execution-time router. |
| Inventory from `@fabric-sdk/gateway` only | Not deployed; phase 1 would have nothing to read. |

## Implementation order

1. `@git-fabric/gateway`: optional `annotations` on `FabricTool`, passed through `tools/list`.
2. Annotate tools in each fabric app; add the `fabric-review` rule (annotations present,
   description of at least N characters).
3. fabric-ctrl: inventory refresher over the loaded registry, lexical matcher, plan
   builder, `fabric.resolve` MCP tool; route `invoke` `dry_run` through it.
4. Rewrite `SEQ-01…06` as tool-level templates.
5. Phase 2: F-RIB consumption and Qdrant matcher, once both are deployed.

Follow-up ADR (separate concern): cross-server write policy in the gateway.
