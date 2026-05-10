/**
 * One-time (re-runnable) indexing pipeline.
 *
 * Clones the exemplar repos, parses TypeScript files into
 * function/class/type/interface chunks, embeds each chunk via Ollama,
 * and stores results in corpus.db (SQLite + sqlite-vec).
 *
 * Usage:
 *   npm run index-corpus
 *
 * Re-running is safe — existing rows for a repo are deleted before re-inserting.
 */

import { execFileSync } from "child_process";
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync } from "fs";
import { join, relative } from "path";
import { tmpdir } from "os";
import { embedBatch } from "../lib/embeddings";
import { insertChunks, deleteChunksForRepo } from "../lib/db";
import type { CorpusChunk } from "../lib/db";

// ─── Corpus definition ───────────────────────────────────────────────────────

type RepoConfig = {
  repo: string;
  url: string;
  patternTags: string[];
  include: string[];        // subdirectories to index (use ["."] for whole repo)
  include_files?: string[]; // specific files to index (relative to repo root)
  exclude: string[];        // path substrings to skip
  allow_dts?: boolean;      // include .d.ts files (for hand-written definition repos)
};

const CORPUS: RepoConfig[] = [
  {
    repo: "sindresorhus/type-fest",
    url: "https://github.com/sindresorhus/type-fest.git",
    patternTags: ["type-design"],
    include: ["source"],
    exclude: [],
    allow_dts: true,
  },
  {
    repo: "colinhacks/zod",
    url: "https://github.com/colinhacks/zod.git",
    patternTags: ["api-ergonomics"],
    include: ["packages/zod/src/v4"],
    exclude: [],
  },
  {
    repo: "trpc/trpc",
    url: "https://github.com/trpc/trpc.git",
    patternTags: ["api-ergonomics"],
    include: ["packages/server/src", "packages/client/src"],
    exclude: [],
  },
  {
    repo: "microsoft/TypeScript",
    url: "https://github.com/microsoft/TypeScript.git",
    patternTags: ["type-design"],
    include: [],
    include_files: ["src/compiler/types.ts"],
    exclude: [],
  },
];

// ─── TypeScript chunker ───────────────────────────────────────────────────────

type ChunkType = "function" | "class" | "type" | "interface" | "enum";

type RawChunk = {
  chunk_type: ChunkType;
  chunk_name: string;
  content: string;
};

// Require `export` — internal utilities are almost never exported and add noise.
const CHUNK_PATTERNS: Array<{ type: ChunkType; pattern: RegExp }> = [
  { type: "function",  pattern: /^export\s+(async\s+)?function\s+(\w+)[^{]*\{/gm },
  { type: "class",     pattern: /^export\s+(abstract\s+)?class\s+(\w+)[^{]*\{/gm },
  { type: "type",      pattern: /^export\s+type\s+(\w+)\s*[<=]/gm },
  { type: "interface", pattern: /^export\s+interface\s+(\w+)[^{]*\{/gm },
  { type: "enum",      pattern: /^export\s+(const\s+)?enum\s+(\w+)\s*\{/gm },
];

function extractChunks(source: string): RawChunk[] {
  const chunks: RawChunk[] = [];
  const lines = source.split("\n");

  for (const { type, pattern } of CHUNK_PATTERNS) {
    let match: RegExpExecArray | null;
    pattern.lastIndex = 0;

    while ((match = pattern.exec(source)) !== null) {
      const name = [...match].reverse().find((g) => g && /^\w+$/.test(g)) ?? "unknown";

      // Find start line from character offset
      let charCount = 0;
      let startLine = 0;
      for (let i = 0; i < lines.length; i++) {
        charCount += (lines[i]?.length ?? 0) + 1;
        if (charCount > match.index) { startLine = i; break; }
      }

      const endLine = Math.min(startLine + 100, lines.length);
      const content = lines.slice(startLine, endLine).join("\n").trim();
      if (content.length > 50) {
        chunks.push({ chunk_type: type, chunk_name: name, content });
      }
    }
  }

  return chunks;
}

// ─── File walker ─────────────────────────────────────────────────────────────

function walkTs(dir: string, excludes: string[], allowDts = false): string[] {
  const files: string[] = [];

  function walk(current: string): void {
    if (!existsSync(current)) return;
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      if (statSync(fullPath).isDirectory()) {
        if (!excludes.some((ex) => fullPath.includes(ex))) walk(fullPath);
      } else if (
        entry.endsWith(".ts") &&
        (allowDts || !entry.endsWith(".d.ts")) &&
        !entry.endsWith(".test.ts") &&
        !/\b(util|utils|helper|helpers|internal|private)\b/i.test(entry) &&
        !excludes.some((ex) => fullPath.includes(ex))
      ) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const BATCH_SIZE = 20;
const BATCH_PAUSE_MS = 500;
const CLONE_DIR = join(tmpdir(), "ts-trainer-index");

async function indexRepo(config: RepoConfig): Promise<void> {
  console.log(`\n▶ Indexing ${config.repo}`);

  const repoDir = join(CLONE_DIR, config.repo.replace("/", "-"));
  mkdirSync(repoDir, { recursive: true });

  if (!existsSync(join(repoDir, ".git"))) {
    console.log("  Cloning (shallow)...");
    // execFileSync avoids shell — args are passed as array, not a shell string
    execFileSync("git", ["clone", "--depth", "1", config.url, repoDir], { stdio: "pipe" });
  } else {
    console.log("  Already cloned, using cache.");
  }

  // Clear existing rows for this repo so re-runs are idempotent
  deleteChunksForRepo(config.repo);

  // Collect TypeScript files from included subdirectories and specific files
  const allFiles: string[] = [];
  for (const subdir of config.include) {
    const targetDir = subdir === "." ? repoDir : join(repoDir, subdir);
    allFiles.push(...walkTs(targetDir, config.exclude, config.allow_dts));
  }
  for (const file of config.include_files ?? []) {
    const filePath = join(repoDir, file);
    if (existsSync(filePath)) allFiles.push(filePath);
  }
  console.log(`  ${allFiles.length} TypeScript files found`);

  // Extract chunks
  const allChunks: Array<{ filePath: string; chunk: RawChunk }> = [];
  for (const filePath of allFiles) {
    const source = readFileSync(filePath, "utf-8");
    for (const chunk of extractChunks(source)) {
      allChunks.push({ filePath, chunk });
    }
  }
  console.log(`  ${allChunks.length} chunks extracted`);

  // Embed in batches and insert into Supabase
  let inserted = 0;
  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map(({ chunk }) => `${chunk.chunk_name}\n${chunk.content}`);
    const embeddings = await embedBatch(texts);

    const rows: CorpusChunk[] = batch.map(({ filePath, chunk }, idx) => ({
      repo: config.repo,
      file_path: relative(repoDir, filePath),
      chunk_type: chunk.chunk_type,
      chunk_name: chunk.chunk_name,
      pattern_tags: config.patternTags,
      content: chunk.content,
      embedding: embeddings[idx] ?? [],
    }));

    await insertChunks(rows);
    inserted += rows.length;
    process.stdout.write(`\r  Stored: ${inserted}/${allChunks.length}`);
    await new Promise((r) => setTimeout(r, BATCH_PAUSE_MS));
  }

  console.log(`\n  ✓ ${inserted} chunks indexed for ${config.repo}`);
}

async function main(): Promise<void> {
  mkdirSync(CLONE_DIR, { recursive: true });
  console.log(`Cloning repos to ${CLONE_DIR}\n`);

  for (const config of CORPUS) {
    await indexRepo(config);
  }

  console.log("\n✓ All repos indexed.");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
