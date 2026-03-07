/**
 * Library — git-based knowledge retrieval for fabric-chat
 *
 * The librarian model: we know where the books are, we go fetch them
 * when asked, and we return them when done. No photocopies.
 *
 * Sources:
 *   - anthropics/anthropic-cookbook — Claude API patterns and best practices
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const LIBRARY_DIR = process.env.LIBRARY_DIR || '/tmp/fabric-library';

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

const SOURCES: LibrarySource[] = [
  {
    id: 'anthropic-cookbook',
    repo: 'https://github.com/anthropics/anthropic-cookbook.git',
    branch: 'main',
    description: 'Anthropic cookbook — Claude API patterns and best practices',
    useRawApi: true,
    topics: [
      { keywords: ['prompt', 'prompting', 'system prompt', 'few-shot'],
        files: ['README.md'],
        description: 'Prompting best practices' },
      { keywords: ['tool', 'tool use', 'function calling'],
        files: ['README.md'],
        description: 'Tool use patterns' },
      { keywords: ['vision', 'image', 'multimodal'],
        files: ['README.md'],
        description: 'Vision and multimodal' },
      { keywords: ['streaming', 'stream', 'sse'],
        files: ['README.md'],
        description: 'Streaming responses' },
      { keywords: ['embedding', 'vector', 'rag', 'retrieval'],
        files: ['README.md'],
        description: 'RAG and embeddings' },
    ],
  },
];

export class Library {
  private cacheDir: string;

  constructor() {
    this.cacheDir = LIBRARY_DIR;
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  findTopics(query: string): { source: LibrarySource; topic: TopicEntry; score: number }[] {
    const q = query.toLowerCase();
    const matches: { source: LibrarySource; topic: TopicEntry; score: number }[] = [];
    for (const source of SOURCES) {
      for (const topic of source.topics) {
        let score = 0;
        for (const kw of topic.keywords) {
          if (q.includes(kw)) score += kw.length;
        }
        if (score > 0) matches.push({ source, topic, score });
      }
    }
    return matches.sort((a, b) => b.score - a.score);
  }

  checkout(source: LibrarySource): string {
    if (source.useRawApi) return '';
    const localPath = join(this.cacheDir, source.id);
    if (existsSync(join(localPath, '.git'))) {
      try { execSync(`git -C ${localPath} pull --depth 1 --rebase 2>/dev/null || true`, { timeout: 15000, stdio: 'pipe' }); } catch {}
      return localPath;
    }
    execSync(`git clone --depth 1 --branch ${source.branch} ${source.repo} ${localPath}`, { timeout: 60000, stdio: 'pipe' });
    return localPath;
  }

  readFiles(source: LibrarySource, files: string[]): string {
    if (source.useRawApi) return this.readFilesFromGitHub(source, files);
    const localPath = this.checkout(source);
    const sections: string[] = [];
    for (const file of files) {
      const fullPath = join(localPath, file);
      if (existsSync(fullPath)) {
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const trimmed = content.length > 8000 ? content.slice(0, 8000) + '\n\n...[truncated]' : content;
          sections.push(`--- ${file} ---\n${trimmed}`);
        } catch {}
      }
    }
    return sections.join('\n\n');
  }

  private readFilesFromGitHub(source: LibrarySource, files: string[]): string {
    const match = source.repo.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (!match) return '';
    const ownerRepo = match[1];
    const sections: string[] = [];
    for (const file of files) {
      try {
        const url = `https://raw.githubusercontent.com/${ownerRepo}/${source.branch}/${file}`;
        const content = execSync(`curl -sf --max-time 10 "${url}"`, { timeout: 12000, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' });
        if (content) {
          const trimmed = content.length > 8000 ? content.slice(0, 8000) + '\n\n...[truncated]' : content;
          sections.push(`--- ${file} ---\n${trimmed}`);
        }
      } catch {}
    }
    return sections.join('\n\n');
  }

  async query(queryText: string): Promise<{ context: string; confidence: number; sources: string[] } | null> {
    const matches = this.findTopics(queryText);
    if (matches.length === 0) return null;
    const topMatches = matches.slice(0, 3);
    const seenFiles = new Set<string>();
    const filesToRead: { source: LibrarySource; file: string }[] = [];
    for (const m of topMatches) {
      for (const f of m.topic.files) {
        const key = `${m.source.id}:${f}`;
        if (!seenFiles.has(key)) { seenFiles.add(key); filesToRead.push({ source: m.source, file: f }); }
      }
    }
    const bySource = new Map<string, { source: LibrarySource; files: string[] }>();
    for (const { source, file } of filesToRead.slice(0, 6)) {
      const existing = bySource.get(source.id);
      if (existing) existing.files.push(file);
      else bySource.set(source.id, { source, files: [file] });
    }
    const sections: string[] = [];
    const sources: string[] = [];
    for (const { source, files } of bySource.values()) {
      try {
        const content = this.readFiles(source, files);
        if (content) { sections.push(content); sources.push(...files.map(f => `${source.id}/${f}`)); }
      } catch {}
    }
    if (sections.length === 0) return null;
    const bestScore = topMatches[0].score;
    return { context: sections.join('\n\n'), confidence: Math.min(0.92, 0.6 + bestScore * 0.04), sources };
  }

  listSources(): { id: string; repo: string; topics: number; description: string }[] {
    return SOURCES.map(s => ({ id: s.id, repo: s.repo, topics: s.topics.length, description: s.description }));
  }
}
