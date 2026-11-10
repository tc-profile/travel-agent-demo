/**
 * Agentic RAG knowledge base. Chunks are embedded offline by
 * scripts/ingest.mjs (Voyage AI) and stored as a single *private* JSON blob
 * in Vercel Blob — private means no public URL, only readable by a request
 * holding BLOB_READ_WRITE_TOKEN. At request time this fetches that JSON once
 * per warm serverless instance and does brute-force cosine similarity in
 * memory — fine at demo scale (one curated doc, a few hundred chunks). No
 * vector DB needed.
 *
 * Source docs live in ../knowledge_base, shared with the CLI's ingest.py —
 * keep both ingestion pipelines pointed at the same folder if it moves.
 */

import { get } from "@vercel/blob";
import { logger } from "./observability";

// Must match BLOB_PATH in scripts/ingest.mjs.
const KNOWLEDGE_BASE_BLOB_PATH = "knowledge-base.json";

type KnowledgeChunk = { id: string; source: string; text: string; embedding: number[] };

let cachedChunks: KnowledgeChunk[] | null = null;

async function loadChunks(): Promise<KnowledgeChunk[]> {
  if (cachedChunks) return cachedChunks;
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return [];

  // Pass the token explicitly rather than relying on @vercel/blob's default
  // resolution: in a `vercel link`-ed local repo with an authenticated CLI,
  // it silently prefers a Vercel OIDC token over BLOB_READ_WRITE_TOKEN, which
  // 403s unless the store is explicitly connected for the current environment.
  const result = await get(KNOWLEDGE_BASE_BLOB_PATH, { access: "private", token }).catch((err) => {
    logger.warn("knowledge_base.load.failed", { outcome: "degraded", error: err, blob_path: KNOWLEDGE_BASE_BLOB_PATH });
    return null;
  });
  if (!result?.stream) return [];

  const text = await new Response(result.stream).text();
  cachedChunks = JSON.parse(text) as KnowledgeChunk[];
  return cachedChunks;
}

async function embedQuery(query: string): Promise<number[] | null> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) return null;
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: [query], model: "voyage-3.5-lite", input_type: "query" }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.data?.[0]?.embedding ?? null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function searchKnowledgeBase(query: string, topK = 4) {
  if (!process.env.VOYAGE_API_KEY) {
    return { error: "VOYAGE_API_KEY is not set — knowledge base search is unavailable." };
  }

  const chunks = await loadChunks();
  if (chunks.length === 0) {
    return {
      error:
        "No knowledge base is available. Run `npm run ingest` (requires BLOB_READ_WRITE_TOKEN), then retry.",
    };
  }

  const queryEmbedding = await embedQuery(query);
  if (!queryEmbedding) return { error: "Failed to embed the query." };

  const matches = chunks
    .map((chunk) => ({ chunk, score: cosineSimilarity(queryEmbedding, chunk.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ chunk }) => ({ source: chunk.source, text: chunk.text }));

  return { matches };
}
