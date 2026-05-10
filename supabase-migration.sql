-- Enable pgvector extension
create extension if not exists vector;

-- Class A: exemplar source chunks from the 6 curated repos
create table if not exists ts_corpus_chunks (
  id          bigserial primary key,
  repo        text        not null,  -- e.g. 'microsoft/TypeScript'
  file_path   text        not null,  -- relative path within repo
  chunk_type  text        not null,  -- 'function' | 'class' | 'type' | 'interface' | 'enum'
  chunk_name  text        not null,  -- name of the symbol
  pattern_tags text[]     not null default '{}',  -- e.g. ['type-design', 'discriminated-unions']
  content     text        not null,  -- the raw TypeScript source
  embedding   vector(768) not null,
  created_at  timestamptz not null default now()
);

-- Class B: Foreman-Worker judgment conversations
create table if not exists ts_judgments (
  id           bigserial primary key,
  task_desc    text        not null,  -- what was being built
  worker_code  text        not null,  -- original Worker output
  edits        text        not null,  -- Orchestrator annotated edits
  pattern_tags text[]      not null default '{}',  -- which patterns were triggered
  embedding    vector(768) not null,
  created_at   timestamptz not null default now()
);

-- Indexes for vector similarity search (cosine distance)
create index if not exists ts_corpus_chunks_embedding_idx
  on ts_corpus_chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists ts_judgments_embedding_idx
  on ts_judgments using ivfflat (embedding vector_cosine_ops)
  with (lists = 50);

-- Retrieval function for corpus chunks
create or replace function match_corpus_chunks(
  query_embedding vector(768),
  match_count     int     default 5,
  pattern_filter  text    default null
)
returns table (
  id          bigint,
  repo        text,
  file_path   text,
  chunk_type  text,
  chunk_name  text,
  pattern_tags text[],
  content     text,
  similarity  float
)
language sql stable
as $$
  select
    id, repo, file_path, chunk_type, chunk_name, pattern_tags, content,
    1 - (embedding <=> query_embedding) as similarity
  from ts_corpus_chunks
  where pattern_filter is null or pattern_tags @> array[pattern_filter]
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Retrieval function for judgment conversations
create or replace function match_judgments(
  query_embedding vector(768),
  match_count     int default 3
)
returns table (
  id           bigint,
  task_desc    text,
  worker_code  text,
  edits        text,
  pattern_tags text[],
  similarity   float
)
language sql stable
as $$
  select
    id, task_desc, worker_code, edits, pattern_tags,
    1 - (embedding <=> query_embedding) as similarity
  from ts_judgments
  order by embedding <=> query_embedding
  limit match_count;
$$;
