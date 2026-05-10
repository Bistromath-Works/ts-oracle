import OpenAI from "openai";

// Ollama exposes an OpenAI-compatible API — no key needed
// OLLAMA_BASE_URL defaults to localhost for native use; Docker sets it to host.docker.internal
const client = new OpenAI({
  baseURL: `${process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434"}/v1`,
  apiKey: "ollama",
});

const MODEL = "nomic-embed-text-v2-moe:latest";

export async function embed(text: string): Promise<number[]> {
  const response = await client.embeddings.create({ model: MODEL, input: text });
  const first = response.data[0];
  if (!first) throw new Error("Ollama returned no embedding");
  return first.embedding;
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
