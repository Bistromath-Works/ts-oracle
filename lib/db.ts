import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import path from "path";

const DB_PATH = process.env["CORPUS_DB_PATH"] ?? path.join(__dirname, "../corpus.db");

export type CorpusChunk = {
  repo: string;
  file_path: string;
  chunk_type: "function" | "class" | "type" | "interface" | "enum";
  chunk_name: string;
  pattern_tags: string[];
  content: string;
  embedding: number[];
};

export type Judgment = {
  task_desc: string;
  worker_code: string;
  edits: string;
  pattern_tags: string[];
  embedding: number[];
};

export type MatchedChunk = {
  id: number;
  repo: string;
  file_path: string;
  chunk_type: string;
  chunk_name: string;
  pattern_tags: string[];
  content: string;
  similarity: number;
};

export type MatchedJudgment = {
  id: number;
  task_desc: string;
  worker_code: string;
  edits: string;
  pattern_tags: string[];
  similarity: number;
};

function normalize(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

function toVecBuffer(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(normalize(vec)).buffer);
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS ts_corpus_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vec_rowid INTEGER NOT NULL,
    repo TEXT NOT NULL,
    file_path TEXT NOT NULL,
    chunk_type TEXT NOT NULL,
    chunk_name TEXT NOT NULL,
    pattern_tags TEXT NOT NULL,
    content TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS vec_corpus USING vec0(embedding FLOAT[768])`,
  `CREATE TABLE IF NOT EXISTS ts_judgments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vec_rowid INTEGER NOT NULL,
    task_desc TEXT NOT NULL,
    worker_code TEXT NOT NULL,
    edits TEXT NOT NULL,
    pattern_tags TEXT NOT NULL
  )`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS vec_judgments USING vec0(embedding FLOAT[768])`,
];

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  sqliteVec.load(_db);
  for (const stmt of SCHEMA_STATEMENTS) {
    _db.prepare(stmt).run();
  }
  return _db;
}

export function deleteChunksForRepo(repo: string): void {
  const db = getDb();
  const rows = db
    .prepare<[string], { vec_rowid: number }>(
      "SELECT vec_rowid FROM ts_corpus_chunks WHERE repo = ?"
    )
    .all(repo);
  if (rows.length === 0) return;

  const deleteVec = db.prepare("DELETE FROM vec_corpus WHERE rowid = ?");
  db.transaction(() => {
    for (const { vec_rowid } of rows) deleteVec.run(vec_rowid);
    db.prepare("DELETE FROM ts_corpus_chunks WHERE repo = ?").run(repo);
  })();
}

export async function insertChunks(chunks: CorpusChunk[]): Promise<void> {
  const db = getDb();
  const insertVec = db.prepare("INSERT INTO vec_corpus(embedding) VALUES (?)");
  const lastRowid = db.prepare("SELECT last_insert_rowid() as id");
  const insertChunk = db.prepare(
    "INSERT INTO ts_corpus_chunks (vec_rowid, repo, file_path, chunk_type, chunk_name, pattern_tags, content) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );

  db.transaction(() => {
    for (const chunk of chunks) {
      insertVec.run(toVecBuffer(chunk.embedding));
      const { id: vecRowid } = lastRowid.get() as { id: number };
      insertChunk.run(
        vecRowid,
        chunk.repo,
        chunk.file_path,
        chunk.chunk_type,
        chunk.chunk_name,
        JSON.stringify(chunk.pattern_tags),
        chunk.content
      );
    }
  })();
}

export async function insertJudgment(judgment: Judgment): Promise<void> {
  const db = getDb();
  const insertVec = db.prepare("INSERT INTO vec_judgments(embedding) VALUES (?)");
  const lastRowid = db.prepare("SELECT last_insert_rowid() as id");
  const insertJ = db.prepare(
    "INSERT INTO ts_judgments (vec_rowid, task_desc, worker_code, edits, pattern_tags) VALUES (?, ?, ?, ?, ?)"
  );

  db.transaction(() => {
    insertVec.run(toVecBuffer(judgment.embedding));
    const { id: vecRowid } = lastRowid.get() as { id: number };
    insertJ.run(vecRowid, judgment.task_desc, judgment.worker_code, judgment.edits, JSON.stringify(judgment.pattern_tags));
  })();
}

export async function retrieveChunks(
  queryEmbedding: number[],
  matchCount = 5,
  patternFilter?: string
): Promise<MatchedChunk[]> {
  const db = getDb();
  const queryBuf = toVecBuffer(queryEmbedding);
  const kFetch = patternFilter ? matchCount * 10 : matchCount;

  const vecRows = db
    .prepare("SELECT rowid, distance FROM vec_corpus WHERE embedding MATCH ? AND k = ?")
    .all(queryBuf, kFetch) as Array<{ rowid: number; distance: number }>;

  if (vecRows.length === 0) return [];

  const idMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));
  const placeholders = vecRows.map(() => "?").join(",");
  const chunkRows = db
    .prepare(
      `SELECT id, vec_rowid, repo, file_path, chunk_type, chunk_name, pattern_tags, content FROM ts_corpus_chunks WHERE vec_rowid IN (${placeholders})`
    )
    .all(...vecRows.map((r) => r.rowid)) as Array<{
    id: number;
    vec_rowid: number;
    repo: string;
    file_path: string;
    chunk_type: string;
    chunk_name: string;
    pattern_tags: string;
    content: string;
  }>;

  return chunkRows
    .filter((row) => {
      if (!patternFilter) return true;
      return (JSON.parse(row.pattern_tags) as string[]).includes(patternFilter);
    })
    .map((row) => {
      const distance = idMap.get(row.vec_rowid) ?? 2;
      return {
        id: row.id,
        repo: row.repo,
        file_path: row.file_path,
        chunk_type: row.chunk_type,
        chunk_name: row.chunk_name,
        pattern_tags: JSON.parse(row.pattern_tags) as string[],
        content: row.content,
        similarity: 1 - (distance * distance) / 2,
      };
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, matchCount);
}

export async function retrieveJudgments(
  queryEmbedding: number[],
  matchCount = 3
): Promise<MatchedJudgment[]> {
  const db = getDb();
  const queryBuf = toVecBuffer(queryEmbedding);

  const vecRows = db
    .prepare("SELECT rowid, distance FROM vec_judgments WHERE embedding MATCH ? AND k = ?")
    .all(queryBuf, matchCount) as Array<{ rowid: number; distance: number }>;

  if (vecRows.length === 0) return [];

  const idMap = new Map(vecRows.map((r) => [r.rowid, r.distance]));
  const placeholders = vecRows.map(() => "?").join(",");
  const judgmentRows = db
    .prepare(
      `SELECT id, vec_rowid, task_desc, worker_code, edits, pattern_tags FROM ts_judgments WHERE vec_rowid IN (${placeholders})`
    )
    .all(...vecRows.map((r) => r.rowid)) as Array<{
    id: number;
    vec_rowid: number;
    task_desc: string;
    worker_code: string;
    edits: string;
    pattern_tags: string;
  }>;

  return judgmentRows
    .map((row) => {
      const distance = idMap.get(row.vec_rowid) ?? 2;
      return {
        id: row.id,
        task_desc: row.task_desc,
        worker_code: row.worker_code,
        edits: row.edits,
        pattern_tags: JSON.parse(row.pattern_tags) as string[],
        similarity: 1 - (distance * distance) / 2,
      };
    })
    .sort((a, b) => b.similarity - a.similarity);
}
