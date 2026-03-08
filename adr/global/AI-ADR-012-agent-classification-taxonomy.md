# AI-ADR-012: Agent Classification Taxonomy

**Status:** Accepted
**Date:** 2026-03-08
**Author:** Ryan / ry-ops.dev
**Scope:** Global — applies to all git-fabric repositories
**Depends On:** AI-ADR-006 (Agent Permission Boundaries), ADR-003 §5-6

## Context

AI-ADR-006 defines what permissions agents get. ADR-003 §5-6 establishes secure agent
architecture and privilege escalation prevention. What was missing is a structured
framework for **classifying agents before assigning permissions** — a taxonomy that
determines how an agent should behave based on what it does and what it touches.

The prevailing mental model treats agents as "super agents" — monolithic systems with
broad agency that can interact with any system and take any action. This is the
Hollywood model. In practice it leads to:

- **Super agency** — agents with unlimited freedom to act
- **Over-privilege** — agents with more permissions than their task requires
- **Uncontrolled blast radius** — a single misbehaving agent can damage everything

The Fabric-SDK was built on the opposite principle: a set of collaborating agents with
narrow, well-defined responsibilities. This ADR formalizes the classification model
that makes that possible.

## Decision

### Core Principles

1. **No super agents.** Every agent has a bounded task. Agents collaborate to complete
   larger processes — no single agent does everything.
2. **Minimize actions and access.** For each agent: what is the minimal action it needs
   to perform? For that action, what is the minimum access it needs? This is high
   cohesion — one agent, one task, one set of permissions.
3. **Agents are not one-size-fits-all.** Different agents require different governance
   based on what they do and what they touch.

### Risk/Capability Classification Quadrant

Agents are classified on two axes:

|  | **Low Risk** (limited damage potential) | **High Risk** (sensitive systems, high damage potential) |
|---|---|---|
| **High Capability** (reasons, non-deterministic, multi-step) | Quadrant II — e.g., internal style guide editor | Quadrant IV — e.g., accounts payable payment initiator |
| **Low Capability** (predetermined actions, deterministic) | Quadrant I — e.g., internal wiki RAG retriever | Quadrant III — e.g., finance data extractor (read-only) |

#### Quadrant I: Low Risk, Low Capability
- **Example:** RAG model reading an internal wiki
- **Characteristics:** Deterministic, predetermined actions, non-sensitive data
- **Governance:** Traditional access controls. Persistent agents. Static credentials (API keys, certificates). Minimal additional controls needed.

#### Quadrant II: High Capability, Low Risk
- **Example:** Internal style guide editor that reads and rewrites content
- **Characteristics:** Non-deterministic, applies reasoning, but operates on non-sensitive data
- **Governance:** Ephemeral agents (come in, do the task, go away). Dynamic access assessed per invocation. Monitor for drift.

#### Quadrant III: Low Capability, High Risk
- **Example:** Finance data extractor with read-only access to sensitive systems
- **Characteristics:** Deterministic, single task, but touches sensitive information
- **Governance:** Persistent agents with extra business controls. Traditional non-human identity (API keys, credentials). Audit logging mandatory. Access scoped to read-only.

#### Quadrant IV: High Risk, High Capability
- **Example:** Accounts payable system that reasons about invoices and initiates payments
- **Characteristics:** Non-deterministic, multi-step reasoning, interacts with sensitive financial systems, takes destructive actions
- **Governance:** **Maximum controls.** Ephemeral agents. Dynamic, context-based access assessed at every step. Human-in-the-loop approval before destructive actions. Short-lived tokens. Full audit trail.

### Agent Lifecycle Rules by Classification

| Property | Low Capability | High Capability |
|---|---|---|
| **Lifecycle** | Persistent — assigned to a specific task, runs continuously | Ephemeral — spins up, completes task, terminates |
| **Actions** | Predetermined — we define exactly what it does | Reasoned — agent determines actions based on context |
| **Determinism** | Deterministic — same input, same output | Non-deterministic — path changes every invocation |
| **Access model** | Static — traditional NHI (API keys, certs, service accounts) | Dynamic — access assessed per path, per invocation |

| Property | Low Risk | High Risk |
|---|---|---|
| **Damage potential** | Limited — non-sensitive data, non-destructive actions | High — sensitive systems, destructive capabilities |
| **Controls** | Standard access controls | Extra business controls, audit logging |
| **Human oversight** | Optional | Required for Quadrant IV (high capability + high risk) |

### Mapping to Fabric-SDK

| Fabric | Quadrant | Rationale |
|---|---|---|
| fabric-aiana (memory recall) | I — Low Risk, Low Capability | Deterministic retrieval from Qdrant. Non-sensitive organic memories. |
| fabric-k8s (cluster read) | III — High Risk, Low Capability | Read-only access to live cluster (sensitive), but predetermined GET/LIST/WATCH actions. |
| fabric-cloudflare (DNS read) | III — High Risk, Low Capability | Read-only access to DNS (sensitive infrastructure), predetermined actions. |
| Gateway interceptor | IV — High Risk, High Capability | Reasons about routing, touches all fabric domains, makes non-deterministic path decisions. Mitigated by firewall as independent policy decision point. |
| Future: fabric-k8s (write) | IV — High Risk, High Capability | Would require own ADR, human-in-the-loop, ephemeral access, full audit trail. |

### Focus Area: Quadrant IV

Quadrant IV agents (high risk, high capability) require the highest governance:

1. **Human-in-the-loop** — before destructive actions, obtain human approval
2. **Ephemeral lifecycle** — agents do not persist; they complete their task and terminate
3. **Dynamic access** — every tool call, every system interaction is assessed in context:
   - Is the agent allowed to connect to this tool?
   - What actions can it take? (read/write/delete)
   - Is this action consistent with the current task context?
4. **Short-lived tokens** — access expires quickly (aligned with ADR-003 §6.3: 300s TTL)
5. **Full audit trail** — every decision, every action, every escalation is logged

Quadrants I and III operate more like traditional systems — persistent agents with
static credentials and standard access controls. The investment in dynamic governance
should be proportional to the quadrant.

## Security Controls

- **Quadrant classification is mandatory** before any new fabric or agent is deployed
- **Classification drives permission assignment** — AI-ADR-006 permissions are scoped
  based on the agent's quadrant
- **Quadrant IV requires dedicated ADR** for each agent (aligned with ADR-003 §6.1)
- **Reclassification triggers review** — if a Quadrant I agent gains write access, it
  moves to Quadrant III or IV and must be re-governed accordingly

## Compliance Mapping

| Framework | Control |
|-----------|---------|
| OWASP LLM #6 | Excessive agency — quadrant model prevents over-privilege by design |
| NIST AI RMF — Govern | Classification taxonomy provides structured risk governance |
| NIST AI RMF — Map | Risk/capability mapping identifies where controls are needed |
| NIST AI RMF — Measure | Quadrant placement is measurable and auditable |
| NIST AI RMF — Manage | Lifecycle rules (ephemeral vs persistent) manage risk proportionally |
| ISO 42001 | Risk-proportional governance aligned with AI management systems |

## Consequences

**Positive:**
- New agents have a clear classification process before deployment
- Governance effort is proportional to risk — low-risk agents aren't over-governed
- Provides the "why" behind AI-ADR-006 permission decisions
- Aligns the entire org on a shared vocabulary for agent classification

**Negative:**
- Quadrant boundaries require judgment — some agents may sit on the border
- Classification must be revisited when agent capabilities change
- Adds a pre-deployment step to the fabric onboarding process

## References

- AI-ADR-006: Agent Permission Boundaries
- ADR-003 §5: Secure Agent Architecture
- ADR-003 §6: Privilege Escalation Prevention
- Source transcript: Agent classification taxonomy discussion (2026-03-08)
- Synced globally via git-fabric/adr → all downstream repos (verified 2026-03-08)
