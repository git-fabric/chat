/**
 * Library — git-based knowledge retrieval for fabric-chat
 *
 * The librarian model: we know where the books are, we go fetch them
 * when asked, and we return them when done. No photocopies.
 *
 * Sources:
 *   - anthropics/anthropic-cookbook — Claude API patterns and best practices
 */
interface LibrarySource {
    id: string;
    repo: string;
    branch: string;
    description: string;
    topics: TopicEntry[];
    useRawApi?: boolean;
}
interface TopicEntry {
    keywords: string[];
    files: string[];
    description: string;
}
export declare class Library {
    private cacheDir;
    constructor();
    findTopics(query: string): {
        source: LibrarySource;
        topic: TopicEntry;
        score: number;
    }[];
    checkout(source: LibrarySource): string;
    readFiles(source: LibrarySource, files: string[]): string;
    private readFilesFromGitHub;
    query(queryText: string): Promise<{
        context: string;
        confidence: number;
        sources: string[];
    } | null>;
    listSources(): {
        id: string;
        repo: string;
        topics: number;
        description: string;
    }[];
}
export {};
//# sourceMappingURL=library.d.ts.map