import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { embed } from "../lib/embeddings";
import { retrieveChunks, retrieveJudgments, insertJudgment } from "../lib/db";

const handler = createMcpHandler(
  (server) => {
    // Tool 1: Retrieve exemplar code from the corpus (Class A)
    server.registerTool(
      "ts_retrieve",
      {
        description:
          "Retrieve TypeScript code examples from the anti-slop corpus. Use when reviewing Worker output or enriching a task assignment. Returns real code from exemplar repos (TypeScript compiler, Zod, tRPC, typescript-eslint, type-fest).",
        inputSchema: {
          query: z.string().describe(
            "Natural language description of the pattern or problem. E.g. 'how to model nullable results without optional fields' or 'discriminated union for API response'"
          ),
          pattern_type: z
            .enum(["type-design", "api-ergonomics"])
            .optional()
            .describe("Filter to a specific pattern category. Omit to search across all categories."),
          match_count: z
            .number().int().min(1).max(10).default(5)
            .describe("Number of examples to return (default 5)"),
        },
      },
      async ({ query, pattern_type, match_count }) => {
        const queryEmbedding = await embed(query);
        const chunks = await retrieveChunks(queryEmbedding, match_count, pattern_type);

        if (chunks.length === 0) {
          return { content: [{ type: "text", text: "No matching examples found in the corpus for this query." }] };
        }

        const formatted = chunks
          .map((c, i) =>
            [
              `## Example ${i + 1} — ${c.chunk_name} (${c.chunk_type})`,
              `**Repo:** ${c.repo}`,
              `**File:** ${c.file_path}`,
              `**Patterns:** ${c.pattern_tags.join(", ")}`,
              `**Similarity:** ${(c.similarity * 100).toFixed(1)}%`,
              "",
              "```typescript",
              c.content,
              "```",
            ].join("\n")
          )
          .join("\n\n---\n\n");

        return { content: [{ type: "text", text: formatted }] };
      }
    );

    // Tool 2: Retrieve past judgment conversations (Class B)
    server.registerTool(
      "ts_retrieve_judgment",
      {
        description:
          "Retrieve past Foreman-Worker judgment conversations from the growing corpus. Use when the Orchestrator wants to see how similar TypeScript problems were handled in previous sessions.",
        inputSchema: {
          query: z.string().describe(
            "Description of the TypeScript pattern or problem you want prior judgments for."
          ),
          match_count: z
            .number().int().min(1).max(5).default(3)
            .describe("Number of past judgments to return (default 3)"),
        },
      },
      async ({ query, match_count }) => {
        const queryEmbedding = await embed(query);
        const judgments = await retrieveJudgments(queryEmbedding, match_count);

        if (judgments.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No prior judgments found for this query. This corpus grows with each Foreman session.",
            }],
          };
        }

        const formatted = judgments
          .map((j, i) =>
            [
              `## Prior Judgment ${i + 1}`,
              `**Task:** ${j.task_desc}`,
              `**Patterns flagged:** ${j.pattern_tags.join(", ")}`,
              `**Similarity:** ${(j.similarity * 100).toFixed(1)}%`,
              "",
              "**Original Worker code:**",
              "```typescript",
              j.worker_code,
              "```",
              "",
              "**Orchestrator edits applied:**",
              j.edits,
            ].join("\n")
          )
          .join("\n\n---\n\n");

        return { content: [{ type: "text", text: formatted }] };
      }
    );

    // Tool 3: Store a new judgment conversation (Class B)
    server.registerTool(
      "ts_store_judgment",
      {
        description:
          "Store a completed Foreman-Worker TypeScript judgment conversation. Call this after the Orchestrator's /ts-review cycle completes and the Worker has applied edits. Grows the corpus over time.",
        inputSchema: {
          task_desc: z.string().describe(
            "Brief description of what was being built (e.g. 'Zod schema for user registration form')"
          ),
          worker_code: z.string().describe(
            "The original TypeScript code the Worker produced before edits"
          ),
          edits: z.string().describe(
            "The full annotated edit list the Orchestrator produced (the /ts-review output)"
          ),
          pattern_tags: z
            .array(z.string())
            .describe("Pattern categories that were triggered (e.g. ['type-design', 'static-analysis'])"),
        },
      },
      async ({ task_desc, worker_code, edits, pattern_tags }) => {
        const embedding = await embed(`${task_desc}\n\n${worker_code}\n\n${edits}`);
        await insertJudgment({ task_desc, worker_code, edits, pattern_tags, embedding });

        return {
          content: [{
            type: "text",
            text: `Judgment stored. Pattern tags: ${pattern_tags.join(", ")}.`,
          }],
        };
      }
    );
  },
  { serverInfo: { name: "ts-trainer", version: "0.1.0" } }
);

export { handler as GET, handler as POST, handler as DELETE };
