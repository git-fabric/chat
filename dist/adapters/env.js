/**
 * Environment adapter
 *
 * Creates a ChatAdapter from environment variables.
 * Used by the CLI, the gateway loader, and direct programmatic use.
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY   — Claude completions + voyage-3-lite embeddings
 *   QDRANT_URL          — Qdrant instance URL (cloud or in-cluster)
 *   QDRANT_API_KEY      — Qdrant API key (omit for in-cluster no-auth)
 *   GITHUB_TOKEN        — state repo read/write access
 *
 * Optional:
 *   GITHUB_STATE_REPO   — defaults to "ry-ops/git-steer-state"
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
// ── Constants ────────────────────────────────────────────────────────────────
const QDRANT_COLLECTION = "chat_fabric__messages__v1";
const EMBEDDING_MODEL = "voyage-3-lite";
const EMBEDDING_DIMS = 512;
const DEFAULT_MODEL = "claude-sonnet-4-6";
const STATE_REPO_DEFAULT = "ry-ops/git-steer-state";
async function ghGet(token, repo, path) {
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    });
    if (res.status === 404)
        return null;
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`GitHub GET ${path} failed (${res.status}): ${body}`);
    }
    const data = (await res.json());
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { content, sha: data.sha };
}
async function ghPut(token, repo, path, content, message, sha) {
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    const body = {
        message,
        content: Buffer.from(content).toString("base64"),
    };
    if (sha)
        body.sha = sha;
    const res = await fetch(url, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub PUT ${path} failed (${res.status}): ${text}`);
    }
}
async function ghDelete(token, repo, path, message, sha) {
    const url = `https://api.github.com/repos/${repo}/contents/${path}`;
    const res = await fetch(url, {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ message, sha }),
    });
    if (!res.ok && res.status !== 404) {
        const text = await res.text();
        throw new Error(`GitHub DELETE ${path} failed (${res.status}): ${text}`);
    }
}
// ── State helpers ────────────────────────────────────────────────────────────
function sessionPath(sessionId) {
    return `chat/sessions/${sessionId}.json`;
}
function messagesPath(sessionId) {
    return `chat/sessions/${sessionId}/messages.jsonl`;
}
const INDEX_PATH = "chat/index.json";
async function readIndex(token, stateRepo) {
    const file = await ghGet(token, stateRepo, INDEX_PATH);
    if (!file)
        return { entries: [] };
    const entries = JSON.parse(file.content);
    return { entries, sha: file.sha };
}
async function writeIndex(token, stateRepo, entries, sha) {
    await ghPut(token, stateRepo, INDEX_PATH, JSON.stringify(entries, null, 2), "chore(chat): update session index", sha);
}
async function readSession(token, stateRepo, sessionId) {
    const file = await ghGet(token, stateRepo, sessionPath(sessionId));
    if (!file)
        return null;
    return { session: JSON.parse(file.content), sha: file.sha };
}
async function writeSession(token, stateRepo, session, sha) {
    await ghPut(token, stateRepo, sessionPath(session.id), JSON.stringify(session, null, 2), `chore(chat): ${sha ? "update" : "create"} session ${session.id}`, sha);
}
async function readMessages(token, stateRepo, sessionId) {
    const file = await ghGet(token, stateRepo, messagesPath(sessionId));
    if (!file)
        return null;
    const messages = file.content
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line));
    return { messages, sha: file.sha };
}
async function appendMessage(token, stateRepo, message) {
    const existing = await readMessages(token, stateRepo, message.sessionId);
    const newLine = JSON.stringify(message) + "\n";
    const updatedContent = existing
        ? existing.messages.map((m) => JSON.stringify(m)).join("\n") + "\n" + newLine
        : newLine;
    await ghPut(token, stateRepo, messagesPath(message.sessionId), updatedContent, `chore(chat): append message ${message.id} to session ${message.sessionId}`, existing?.sha);
}
async function qdrantEnsureCollection(qdrantUrl, qdrantKey) {
    const url = `${qdrantUrl}/collections/${QDRANT_COLLECTION}`;
    const checkRes = await fetch(url, {
        headers: { "api-key": qdrantKey },
    });
    if (checkRes.ok)
        return; // already exists
    const createRes = await fetch(url, {
        method: "PUT",
        headers: {
            "api-key": qdrantKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            vectors: {
                size: EMBEDDING_DIMS,
                distance: "Cosine",
            },
        }),
    });
    if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Qdrant create collection failed (${createRes.status}): ${text}`);
    }
}
async function qdrantUpsert(qdrantUrl, qdrantKey, point) {
    const res = await fetch(`${qdrantUrl}/collections/${QDRANT_COLLECTION}/points`, {
        method: "PUT",
        headers: {
            "api-key": qdrantKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ points: [point] }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant upsert failed (${res.status}): ${text}`);
    }
}
async function qdrantSearch(qdrantUrl, qdrantKey, vector, filter, limit) {
    const body = {
        vector,
        limit,
        with_payload: true,
    };
    if (filter)
        body.filter = filter;
    const res = await fetch(`${qdrantUrl}/collections/${QDRANT_COLLECTION}/points/search`, {
        method: "POST",
        headers: {
            "api-key": qdrantKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant search failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    return data.result;
}
async function qdrantDeleteBySessionId(qdrantUrl, qdrantKey, sessionId) {
    const res = await fetch(`${qdrantUrl}/collections/${QDRANT_COLLECTION}/points/delete`, {
        method: "POST",
        headers: {
            "api-key": qdrantKey,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            filter: {
                must: [
                    {
                        key: "sessionId",
                        match: { value: sessionId },
                    },
                ],
            },
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant delete by sessionId failed (${res.status}): ${text}`);
    }
}
// ── Token counting helpers ────────────────────────────────────────────────────
function isoToday() {
    return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}
// ── Voyage AI embeddings (via Anthropic API key) ─────────────────────────────
async function voyageEmbed(anthropicKey, text) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${anthropicKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            input: [text],
            model: EMBEDDING_MODEL,
        }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Voyage embed failed (${res.status}): ${body}`);
    }
    const data = await res.json();
    return data.data[0].embedding;
}
// ── createAdapterFromEnv ─────────────────────────────────────────────────────
export function createAdapterFromEnv() {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey)
        throw new Error("ANTHROPIC_API_KEY required");
    const qdrantUrl = process.env.QDRANT_URL;
    if (!qdrantUrl)
        throw new Error("QDRANT_URL required");
    // QDRANT_API_KEY is optional for in-cluster no-auth deployments
    const qdrantKey = process.env.QDRANT_API_KEY ?? "";
    const githubToken = process.env.GITHUB_TOKEN;
    if (!githubToken)
        throw new Error("GITHUB_TOKEN required");
    const stateRepo = process.env.GITHUB_STATE_REPO ?? STATE_REPO_DEFAULT;
    const anthropic = new Anthropic({ apiKey: anthropicKey });
    // Lazy collection creation — only on first embedAndStore/search
    let collectionReady = false;
    async function ensureCollection() {
        if (collectionReady)
            return;
        await qdrantEnsureCollection(qdrantUrl, qdrantKey);
        collectionReady = true;
    }
    return {
        // ── Sessions ────────────────────────────────────────────────────────────
        async createSession(opts) {
            const now = new Date().toISOString();
            const session = {
                id: randomUUID(),
                title: opts.title,
                project: opts.project,
                model: opts.model ?? DEFAULT_MODEL,
                systemPrompt: opts.systemPrompt,
                state: "active",
                createdAt: now,
                updatedAt: now,
                messageCount: 0,
                totalInputTokens: 0,
                totalOutputTokens: 0,
            };
            // Write session file
            await writeSession(githubToken, stateRepo, session);
            // Update index
            const { entries, sha: indexSha } = await readIndex(githubToken, stateRepo);
            entries.unshift({
                id: session.id,
                title: session.title,
                project: session.project,
                state: session.state,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                messageCount: session.messageCount,
            });
            await writeIndex(githubToken, stateRepo, entries, indexSha);
            return session;
        },
        async listSessions(opts) {
            const { entries } = await readIndex(githubToken, stateRepo);
            let filtered = entries;
            if (opts.state !== "all") {
                filtered = entries.filter((e) => e.state === opts.state);
            }
            if (opts.project) {
                filtered = filtered.filter((e) => e.project === opts.project);
            }
            filtered = filtered.slice(0, opts.limit);
            // Fetch full session objects (for fields like model, systemPrompt, token counts)
            const sessions = await Promise.all(filtered.map(async (entry) => {
                const result = await readSession(githubToken, stateRepo, entry.id);
                if (!result) {
                    // Index out of sync — return stub from index
                    return {
                        id: entry.id,
                        title: entry.title,
                        project: entry.project,
                        model: DEFAULT_MODEL,
                        state: entry.state,
                        createdAt: entry.createdAt,
                        updatedAt: entry.updatedAt,
                        messageCount: entry.messageCount,
                        totalInputTokens: 0,
                        totalOutputTokens: 0,
                    };
                }
                return result.session;
            }));
            return sessions;
        },
        async getSession(sessionId) {
            const result = await readSession(githubToken, stateRepo, sessionId);
            if (!result)
                throw new Error(`Session not found: ${sessionId}`);
            const msgs = await readMessages(githubToken, stateRepo, sessionId);
            return { ...result.session, messages: msgs?.messages ?? [] };
        },
        async updateSession(sessionId, patch) {
            const result = await readSession(githubToken, stateRepo, sessionId);
            if (!result)
                throw new Error(`Session not found: ${sessionId}`);
            const updated = {
                ...result.session,
                ...patch,
                updatedAt: new Date().toISOString(),
            };
            await writeSession(githubToken, stateRepo, updated, result.sha);
            // Update index
            const { entries, sha: indexSha } = await readIndex(githubToken, stateRepo);
            const idx = entries.findIndex((e) => e.id === sessionId);
            if (idx !== -1) {
                entries[idx] = {
                    ...entries[idx],
                    title: updated.title,
                    state: updated.state,
                    updatedAt: updated.updatedAt,
                };
                await writeIndex(githubToken, stateRepo, entries, indexSha);
            }
            return updated;
        },
        async deleteSession(sessionId) {
            const result = await readSession(githubToken, stateRepo, sessionId);
            if (!result)
                throw new Error(`Session not found: ${sessionId}`);
            // Delete session file
            await ghDelete(githubToken, stateRepo, sessionPath(sessionId), `chore(chat): delete session ${sessionId}`, result.sha);
            // Delete messages file if it exists
            const msgs = await readMessages(githubToken, stateRepo, sessionId);
            if (msgs) {
                await ghDelete(githubToken, stateRepo, messagesPath(sessionId), `chore(chat): delete messages for session ${sessionId}`, msgs.sha);
            }
            // Remove from Qdrant
            try {
                await qdrantDeleteBySessionId(qdrantUrl, qdrantKey, sessionId);
            }
            catch {
                // Non-fatal: Qdrant vectors are best-effort during deletion
            }
            // Remove from index
            const { entries, sha: indexSha } = await readIndex(githubToken, stateRepo);
            const filtered = entries.filter((e) => e.id !== sessionId);
            await writeIndex(githubToken, stateRepo, filtered, indexSha);
        },
        // ── Messages ────────────────────────────────────────────────────────────
        async getMessages(sessionId, limit, offset) {
            const msgs = await readMessages(githubToken, stateRepo, sessionId);
            if (!msgs)
                return [];
            return msgs.messages.slice(offset, offset + limit);
        },
        async addMessage(msg) {
            const message = {
                ...msg,
                id: randomUUID(),
                timestamp: new Date().toISOString(),
            };
            await appendMessage(githubToken, stateRepo, message);
            // Update session stats
            const sessionResult = await readSession(githubToken, stateRepo, msg.sessionId);
            if (sessionResult) {
                const updated = {
                    ...sessionResult.session,
                    messageCount: sessionResult.session.messageCount + 1,
                    totalInputTokens: sessionResult.session.totalInputTokens + (msg.inputTokens ?? 0),
                    totalOutputTokens: sessionResult.session.totalOutputTokens + (msg.outputTokens ?? 0),
                    updatedAt: message.timestamp,
                };
                await writeSession(githubToken, stateRepo, updated, sessionResult.sha);
                // Update index entry
                const { entries, sha: indexSha } = await readIndex(githubToken, stateRepo);
                const idx = entries.findIndex((e) => e.id === msg.sessionId);
                if (idx !== -1) {
                    entries[idx] = {
                        ...entries[idx],
                        messageCount: updated.messageCount,
                        updatedAt: updated.updatedAt,
                    };
                    await writeIndex(githubToken, stateRepo, entries, indexSha);
                }
            }
            return message;
        },
        // ── LLM ──────────────────────────────────────────────────────────────────
        async complete(messages, opts) {
            // Filter out system messages from the messages array;
            // system prompt is passed separately to Anthropic
            const userAssistantMessages = messages.filter((m) => m.role === "user" || m.role === "assistant");
            const response = await anthropic.messages.create({
                model: opts.model,
                max_tokens: opts.maxTokens,
                system: opts.systemPrompt,
                messages: userAssistantMessages,
            });
            const textBlock = response.content.find((b) => b.type === "text");
            const content = textBlock && textBlock.type === "text" ? textBlock.text : "";
            return {
                content,
                inputTokens: response.usage.input_tokens,
                outputTokens: response.usage.output_tokens,
                model: opts.model,
            };
        },
        // ── Semantic search ───────────────────────────────────────────────────────
        async embed(text) {
            return voyageEmbed(anthropicKey, text);
        },
        async embedAndStore(message) {
            await ensureCollection();
            const vector = await voyageEmbed(anthropicKey, message.content);
            await qdrantUpsert(qdrantUrl, qdrantKey, {
                id: message.id,
                vector,
                payload: {
                    sessionId: message.sessionId,
                    role: message.role,
                    content: message.content,
                    model: message.model ?? null,
                    timestamp: message.timestamp,
                    project: null, // enriched by caller if needed
                    metadata: message.metadata ?? null,
                },
            });
        },
        async searchMessages(query, opts) {
            await ensureCollection();
            // Build Qdrant filter
            const mustClauses = [];
            if (opts.sessionId) {
                mustClauses.push({ key: "sessionId", match: { value: opts.sessionId } });
            }
            if (opts.project) {
                mustClauses.push({ key: "project", match: { value: opts.project } });
            }
            const filter = mustClauses.length > 0 ? { must: mustClauses } : undefined;
            const results = await qdrantSearch(qdrantUrl, qdrantKey, query, filter, opts.limit);
            return results.map((r) => ({
                id: r.id,
                sessionId: r.payload.sessionId,
                role: r.payload.role,
                content: r.payload.content,
                model: r.payload.model ?? undefined,
                timestamp: r.payload.timestamp,
                metadata: r.payload.metadata,
                score: r.score,
            }));
        },
        // ── Stats / health ────────────────────────────────────────────────────────
        async getStats() {
            const { entries } = await readIndex(githubToken, stateRepo);
            const totalSessions = entries.length;
            const totalMessages = entries.reduce((sum, e) => sum + e.messageCount, 0);
            // Count tokens today by inspecting sessions updated today
            const today = isoToday();
            const updatedToday = entries.filter((e) => e.updatedAt.startsWith(today));
            let tokensToday = 0;
            await Promise.all(updatedToday.map(async (entry) => {
                const result = await readSession(githubToken, stateRepo, entry.id);
                if (result) {
                    tokensToday +=
                        result.session.totalInputTokens +
                            result.session.totalOutputTokens;
                }
            }));
            return { totalSessions, totalMessages, tokensToday };
        },
        async health() {
            // Anthropic ping
            const anthropicStart = Date.now();
            try {
                await anthropic.messages.create({
                    model: "claude-haiku-4-5-20251001",
                    max_tokens: 1,
                    messages: [{ role: "user", content: "ping" }],
                });
            }
            catch {
                // Ignore — we measure latency regardless
            }
            const anthropicLatency = Date.now() - anthropicStart;
            // Qdrant ping
            const qdrantStart = Date.now();
            try {
                await fetch(`${qdrantUrl}/healthz`, {
                    headers: { "api-key": qdrantKey },
                });
            }
            catch {
                // Ignore — we measure latency regardless
            }
            const qdrantLatency = Date.now() - qdrantStart;
            return {
                anthropic: { latencyMs: anthropicLatency },
                qdrant: { latencyMs: qdrantLatency },
            };
        },
    };
}
//# sourceMappingURL=env.js.map