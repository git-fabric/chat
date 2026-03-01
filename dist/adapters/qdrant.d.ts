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
export declare const COLLECTION = "chat_fabric__v2";
export declare const EMBEDDING_DIMS = 512;
export interface QdrantPoint {
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
}
export interface QdrantSearchResult {
    id: string;
    score: number;
    payload: Record<string, unknown>;
}
export interface QdrantScrollResult {
    points: Array<{
        id: string;
        payload: Record<string, unknown>;
    }>;
    next_page_offset: string | null;
}
export declare function ensureCollection(qdrantUrl: string, qdrantKey: string): Promise<void>;
export declare function upsertPoint(qdrantUrl: string, qdrantKey: string, point: QdrantPoint): Promise<void>;
export declare function upsertPointNoVec(qdrantUrl: string, qdrantKey: string, id: string, payload: Record<string, unknown>): Promise<void>;
export declare function setPayload(qdrantUrl: string, qdrantKey: string, id: string, payload: Record<string, unknown>): Promise<void>;
export declare function deleteByFilter(qdrantUrl: string, qdrantKey: string, filter: Record<string, unknown>): Promise<void>;
export declare function deleteById(qdrantUrl: string, qdrantKey: string, id: string): Promise<void>;
export declare function search(qdrantUrl: string, qdrantKey: string, vector: number[], filter: Record<string, unknown> | undefined, limit: number): Promise<QdrantSearchResult[]>;
export declare function scroll(qdrantUrl: string, qdrantKey: string, filter: Record<string, unknown>, limit: number, offset?: string): Promise<QdrantScrollResult>;
export declare function getPoint(qdrantUrl: string, qdrantKey: string, id: string): Promise<Record<string, unknown> | null>;
//# sourceMappingURL=qdrant.d.ts.map