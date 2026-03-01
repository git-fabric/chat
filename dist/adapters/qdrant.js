/**
 * Qdrant adapter
 *
 * All Qdrant REST operations: collection management, upsert, search,
 * scroll (for listing sessions/messages), and delete.
 *
 * Sessions and messages are both stored in a single collection with
 * a `_type` field discriminating them.
 *
 * Collection: chat_fabric__v2
 * Vectors:    512-dim Voyage AI voyage-3-lite, Cosine distance
 */
export const COLLECTION = "chat_fabric__v2";
export const EMBEDDING_DIMS = 512;
// ── Collection bootstrap ──────────────────────────────────────────────────────
export async function ensureCollection(qdrantUrl, qdrantKey) {
    const url = `${qdrantUrl}/collections/${COLLECTION}`;
    const checkRes = await fetch(url, { headers: { "api-key": qdrantKey } });
    if (checkRes.ok)
        return;
    const createRes = await fetch(url, {
        method: "PUT",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify({ vectors: { size: EMBEDDING_DIMS, distance: "Cosine" } }),
    });
    if (!createRes.ok) {
        const text = await createRes.text();
        throw new Error(`Qdrant create collection failed (${createRes.status}): ${text}`);
    }
}
// ── CRUD ─────────────────────────────────────────────────────────────────────
export async function upsertPoint(qdrantUrl, qdrantKey, point) {
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points`, {
        method: "PUT",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify({ points: [point] }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant upsert failed (${res.status}): ${text}`);
    }
}
export async function upsertPointNoVec(qdrantUrl, qdrantKey, id, payload) {
    // Upsert with a zero vector — used for sessions which don't need vector search
    const zero = new Array(EMBEDDING_DIMS).fill(0);
    await upsertPoint(qdrantUrl, qdrantKey, { id, vector: zero, payload });
}
export async function setPayload(qdrantUrl, qdrantKey, id, payload) {
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/payload`, {
        method: "POST",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify({ payload, points: [id] }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant set payload failed (${res.status}): ${text}`);
    }
}
export async function deleteByFilter(qdrantUrl, qdrantKey, filter) {
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify({ filter }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant delete failed (${res.status}): ${text}`);
    }
}
export async function deleteById(qdrantUrl, qdrantKey, id) {
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/delete`, {
        method: "POST",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify({ points: [id] }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant delete by id failed (${res.status}): ${text}`);
    }
}
// ── Search ────────────────────────────────────────────────────────────────────
export async function search(qdrantUrl, qdrantKey, vector, filter, limit) {
    const body = { vector, limit, with_payload: true };
    if (filter)
        body.filter = filter;
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/search`, {
        method: "POST",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant search failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    return data.result;
}
// ── Scroll (paginated listing) ────────────────────────────────────────────────
export async function scroll(qdrantUrl, qdrantKey, filter, limit, offset) {
    const body = {
        filter,
        limit,
        with_payload: true,
        with_vector: false,
    };
    if (offset)
        body.offset = offset;
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/scroll`, {
        method: "POST",
        headers: { "api-key": qdrantKey, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant scroll failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    return data.result;
}
// ── Get single point ──────────────────────────────────────────────────────────
export async function getPoint(qdrantUrl, qdrantKey, id) {
    const res = await fetch(`${qdrantUrl}/collections/${COLLECTION}/points/${id}`, {
        headers: { "api-key": qdrantKey },
    });
    if (res.status === 404)
        return null;
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Qdrant get point failed (${res.status}): ${text}`);
    }
    const data = (await res.json());
    return data.result?.payload ?? null;
}
//# sourceMappingURL=qdrant.js.map