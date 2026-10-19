# ADR-010: MCP vs Skills — Trust Boundary and Workload Placement for AI Agents

**Status:** Accepted  
**Date:** 2026-07-08  
**Author:** Ryan / ry-ops.dev  
**Scope:** Global — applies to all git-fabric repositories  
**Depends On:** AI-ADR-012 (Agent Classification Taxonomy), AI-ADR-006 (Agent Permission Boundaries)  
**See Also:** fabric-forge/social ADR-010 (stack-specific instantiation)

---

## Context

The prevailing framing for AI agent tool design — "MCP for external data, Skills for
domain behavior" — is useful but incomplete. It answers *what* an agent does, but omits
two questions that determine architectural correctness in constrained environments:

1. **WHERE does authorization live?** — credentials must stay at a boundary that is
   independently rotatable and auditable, not scattered across scripts, agents, or runners.
2. **WHICH runtime pays for the call?** — every network call has a cost profile
   (tokens, subrequests, API limits, character billing, quota). The right shape of a
   workload depends on knowing those costs before writing any code.

The git-fabric ecosystem spans multiple constrained runtimes — Cloudflare Workers (50
subrequests/invocation free), GitHub Actions (no subrequest limit, plan minutes budget),
Upstash Redis (HTTP REST, one request per command), ElevenLabs (character billing),
Anthropic (per-token billing), and Qdrant Cloud (rate-limited free tier). Decisions made
without modeling these costs have caused real production failures.

This ADR formalizes the three-way classification (Skill / MCP / Hybrid) and the runtime
placement rule for each, alongside the trust boundary pattern that both the
`social-api.ry-ops.dev` Worker and the `git-fabric/sdk` Interceptor already implement.

---

## Decision

### The Three-Way Classification

#### Type 1: Skill

A **Skill** is stateless, deterministic, and carries no credentials. It is a pure
transform, a prompt pattern, or a domain behavior that can be loaded into an LLM's
context window or called as a pure function at zero network cost.

**Use a Skill when:**
- The behavior must be identical across every invocation (pronunciation correction,
  output format, scoring threshold, routing keyword matching)
- Domain knowledge is stable between calls — it does not require live database or API state
- The operation is a pure transform: data in → transformed data out
- No credentials are required
- Cost must be zero (zero subrequests, zero API calls)

**Examples across the git-fabric org:**
| Skill | Location | What it does |
|-------|----------|--------------|
| `speakable(text)` | `scripts/pronunciations.mjs` | Corrects IT term pronunciation before TTS — deterministic, zero cost, shared across render pipelines |
| `routeQuery(query)` | `git-fabric/gateway moe.ts` | Keyword-to-app scoring — pure function, no I/O, determines which app handles a request |
| `renderShortSlideSvg()` | `src/carousel/generate.ts` | Deterministic SVG from seeded parameters — same carousel always produces same visual |
| `inferCategory()` | `src/carousel/generate.ts` | Tag/title → display category — scored pattern matching, no network |
| CLAUDE.md / SKILL.md | Any repo | Architectural rules, prompt patterns — loaded into context window, not executed |

#### Type 2: MCP Tool

An **MCP tool** is a permissioned, network-mediated call to a real-time data source or
action. It is the standardized layer between an LLM and state it cannot hold itself.

**Use an MCP tool when:**
- The operation requires real-time state (schedule queue, OAuth tokens, analytics)
- Authorization is required and must stay server-side
- The result changes between calls (not cacheable in the LLM's context window)
- The tool is called at most **O(1) times per agent turn** — never in a loop

**Critical constraint:** MCP tools exposed through a Cloudflare Worker inherit the
Worker's subrequest budget (50 free / 1000 paid per invocation). A tool that loops over
N items, issuing one Redis/API call per item, will exhaust this budget. A tool that reads
a collection uses MGET (one subrequest). A tool that acts on N items dispatches to
GitHub Actions.

**Examples:**
| MCP Tool | Runtime | What it does |
|----------|---------|--------------|
| `social_schedule_list` | Worker | Redis ZRANGE — one subrequest |
| `social_post_generate` | Worker | Anthropic call proxied — credentials stay server-side |
| `/api/audio/tts` | Worker | ElevenLabs proxied — API key never exposed |
| `fabric_route` | git-fabric/gateway | Registry dispatch to matching app — one I/O call |

#### Type 3: Hybrid (Skill decides → MCP executes)

A **Hybrid** is the answer to AI-ADR-012's Quadrant IV (high-risk × high-capability).
A Skill-style function determines *what* to do (stateless, deterministic, over
already-loaded context), then a single MCP call or GitHub Actions dispatch *does* it.
Non-determinism is contained; execution is one bounded network call.

**Structure:**
```
Phase 1 (Skill): stateless decision over already-loaded context
    ↓
Phase 2 (MCP/Actions): single bounded execution call
```

These phases are **sequential and never interleaved**. Decision logic inside a loop
that makes network calls is not a Hybrid — it is an ADR-009 violation.

**Examples:**
| Hybrid | Decision (Skill) | Execution (MCP/Actions) |
|--------|-----------------|------------------------|
| YouTube Shorts auto-dispatch | Match carousels to scheduled posts (filter over loaded MGET result) | Dispatch GitHub workflow per match (one Actions API call each, capped) |
| Autopilot scoring | Compare relevance score to threshold | ZADD to schedule queue if ≥ threshold |
| TTS pipeline | `speakable(text)` normalizes input | POST /api/audio/tts once per slide |
| `fabric_suggest → fabric_route` | `routeQuery()` scores keywords | `fabric_route` dispatches to matched app |

---

### The Trust Boundary Pattern

**One trust boundary per scope.** External service credentials are accessed exclusively
through a gateway endpoint. Scripts and agents call gateway endpoints; they do not call
external APIs with raw credentials passed as environment variables.

| Scope | Trust Boundary | Holds |
|-------|---------------|-------|
| fabric-forge/social | `social-api.ry-ops.dev` (Cloudflare Worker) | LinkedIn, YouTube, ElevenLabs, Anthropic API keys |
| git-fabric org-wide | `git-fabric/sdk` Interceptor layer | Proxmox, Tailscale, Cloudflare, Sandfly, Qdrant, GitHub PAT |

**Benefits:**
- Rotating a credential is a single-point change
- A compromised runner or agent cannot use credentials it has never seen
- Audit trail is at the gateway, not scattered across N scripts

**Exception:** `GITHUB_TOKEN` in GitHub Actions workflows is Actions-native and never
crosses to the Worker.

---

### Runtime Placement Matrix

| Workload type | Runtime | Rationale |
|---------------|---------|-----------|
| Pure transform / prompt pattern | Anywhere | No network, no budget, no auth needed |
| O(1) read + auth needed | Worker or SDK gateway | Subrequest budget permits it |
| O(1) write + auth needed | Worker or SDK gateway | Same |
| Bulk per-item read/write (N items) | GitHub Actions only | No subrequest limit |
| Bulk render / encode | GitHub Actions only | Filesystem + long runtime |
| Credential management | Worker / SDK only | Never in scripts or Actions env |

---

## Constraints

### C-010-001 — Skill: no network calls (HARD)

A function classified as a Skill must make zero network calls and hold zero credentials.
If a "skill" needs to read Redis, call an external API, or fetch any live state, it is
an MCP tool and must be placed at the Worker or SDK gateway.

**Violation:** NO-GO

### C-010-002 — MCP: O(1) subrequests per tool invocation (HARD)

An MCP tool exposed through a Cloudflare Worker or the git-fabric gateway must not issue
per-item network calls in a loop. Reads use MGET. Bulk execution dispatches to GitHub
Actions. This applies at the tool design phase — not as a post-hoc optimization.

**Violation:** NO-GO

### C-010-003 — Credentials at the gateway boundary (HARD)

External service credentials are accessed only through gateway endpoints (Worker or SDK
Interceptor). Scripts call `/api/*` Worker routes or SDK gateway routes. No raw API key
for an external service appears in a script, an environment variable, or an Actions secret
unless it is the gateway's own authentication credential.

**Violation:** NO-GO

### C-010-004 — Determinism via Skill (SOFT)

Any behavior that must be identical across every invocation of a pipeline (pronunciation,
output format, routing logic, scoring threshold) is implemented as a Skill. Non-determinism
is confined to content generation only. Structure, transformation, and routing are deterministic.

**Violation:** REVIEW

### C-010-005 — Hybrid: sequential phases, never interleaved (SOFT)

Hybrid workloads keep the decision phase and execution phase sequential. Decision logic
that makes network calls in the same loop as execution is not a Hybrid — it is a
C-010-002 violation. Reference shape: `dispatchDueShorts()` loads all relevant state in
two MGET calls, filters in memory, then dispatches one GitHub Actions workflow per match.

**Violation:** REVIEW

### C-010-006 — Classify before implementing (SOFT)

New tools and workloads added to any git-fabric gateway or Worker must be classified as
Skill, MCP, or Hybrid before implementation begins. The classification must be consistent
with the quadrant assigned in AI-ADR-012. Quadrant IV workloads (high-risk × high-capability)
require the Hybrid pattern and human approval before execution.

**Violation:** REVIEW

---

## Consequences

**Positive:**
- Every new workload has a classification (Skill / MCP / Hybrid) before any code is
  written — decision made once, not re-litigated in code review
- The subrequest budget (ADR-009 in fabric-forge/social) becomes a first-class concern at
  the MCP design layer, not just at the handler layer after a production blowout
- The gateway-as-trust-boundary pattern that already exists implicitly is now named and
  auditable — credential rotation is a single-point operation in both the Worker and SDK
- Determinism constraint (C-010-004) prevents "why does the output differ this time?" bugs
  by isolating LLM non-determinism to content generation only
- Connects fabric-forge/social to git-fabric via a shared vocabulary — `routeQuery` in
  the gateway is a Skill; `fabric_route` is an MCP. Same pattern, same name, both repos.
- Extends AI-ADR-012's quadrant model with a concrete implementation rule: the Hybrid
  pattern is the correct and safe way to implement Quadrant IV workloads.

**Risks:**
| Risk | Mitigation |
|------|-----------|
| New contributors implement a "Skill" that quietly makes network calls | C-010-001 is NO-GO. Code review checks for fetch/redis/external API calls in any module classified as a Skill. |
| Raw API keys appear in Actions secrets as scripts grow | C-010-003 is NO-GO. All scripts call gateway endpoints. No external service key appears in script env vars. |
| New gateway tools added without referencing this ADR | C-010-006 requires classification before implementation. Existing examples (routeQuery = Skill, fabric_route = MCP) serve as the reference. |
| Hybrid phases drift together as features are added inline | C-010-005 REVIEW. Canonical reference: `dispatchDueShorts()` — decision over loaded MGET result, then bounded dispatch. |

---

## Notes

**The canonical Skill example:** `pronunciations.mjs` — deterministic, stateless, zero
cost, solves a real non-determinism problem (TTS mispronouncing "nginx"), shared across
three render pipelines from one file. Every new workload should ask: *"Is this a
`pronunciations.mjs` (Skill), a `social_schedule_post` (MCP), or a
`dispatchDueShorts` (Hybrid)?"* The answer determines the pattern, the runtime, and
which constraints apply.

**Connection to IBM Technology "MCP vs Skills" framing:** Their model — MCP for
external data, Skills for domain behavior — is the entry point. This ADR answers the
part they omit: WHERE authorization lives, WHICH runtime pays for the call, and HOW to
contain non-determinism when both patterns are needed in the same workload. The Hybrid
pattern (Skill decides → MCP executes) is what makes Quadrant IV workloads from
AI-ADR-012 safe to build.
