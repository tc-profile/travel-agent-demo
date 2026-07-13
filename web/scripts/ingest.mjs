#!/usr/bin/env node
/**
 * Embeds documents from ../../knowledge_base (shared with the CLI's
 * ingest.py) and uploads them as a single *private* JSON blob to Vercel
 * Blob storage, at the fixed pathname KNOWLEDGE_BASE_BLOB_PATH (also used
 * by lib/knowledge.ts to read it back). Private access means the blob has
 * no public URL — only a request holding BLOB_READ_WRITE_TOKEN can read it.
 * Run this whenever the shared docs change; no other env var needs updating.
 *
 * Usage:
 *   node --env-file=.env.local scripts/ingest.mjs
 *
 * Requires VOYAGE_API_KEY and BLOB_READ_WRITE_TOKEN in .env.local.
 */

import { readFileSync, readdirSync } from "node:fs";
import { extname, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { put } from "@vercel/blob";
import pdfParse from "pdf-parse";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(__dirname, "..", "..", "knowledge_base");
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 150;
const EMBED_MODEL = "voyage-3.5-lite";
// Must match KNOWLEDGE_BASE_BLOB_PATH in lib/knowledge.ts.
const BLOB_PATH = "knowledge-base.json";

function chunkText(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  const chunks = [];
  let start = 0;
  while (start < collapsed.length) {
    const end = start + CHUNK_SIZE;
    chunks.push(collapsed.slice(start, end));
    start = end - CHUNK_OVERLAP;
    if (start <= 0) break;
  }
  return chunks.filter((c) => c.trim().length > 0);
}

async function readText(path) {
  if (extname(path).toLowerCase() === ".pdf") {
    const parsed = await pdfParse(readFileSync(path));
    return parsed.text;
  }
  return readFileSync(path, "utf-8");
}

async function embedBatch(texts, apiKey) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: texts, model: EMBED_MODEL, input_type: "document" }),
  });
  if (!res.ok) throw new Error(`Voyage embeddings request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function main() {
  const voyageKey = process.env.VOYAGE_API_KEY;
  const blobToken = process.env.BLOB_READ_WRITE_TOKEN;
  if (!voyageKey) throw new Error("VOYAGE_API_KEY is not set in .env.local");
  if (!blobToken) {
    throw new Error(
      "BLOB_READ_WRITE_TOKEN is not set in .env.local — create a Blob store in the Vercel " +
        "dashboard (Storage tab) or run `vercel env pull` after adding one."
    );
  }

  const files = readdirSync(KB_DIR).filter((f) => [".txt", ".md", ".pdf"].includes(extname(f).toLowerCase()));
  if (files.length === 0) throw new Error(`No .txt/.md/.pdf files found in ${KB_DIR}`);

  const chunks = [];
  for (const file of files) {
    const text = await readText(join(KB_DIR, file));
    chunkText(text).forEach((piece, i) => {
      chunks.push({ id: `${file}::${i}`, source: file, text: piece });
    });
  }

  console.log(`Embedding ${chunks.length} chunks from ${files.length} file(s): ${files.join(", ")}`);
  const embeddings = await embedBatch(
    chunks.map((c) => c.text),
    voyageKey
  );
  const withEmbeddings = chunks.map((c, i) => ({ ...c, embedding: embeddings[i] }));

  await put(BLOB_PATH, JSON.stringify(withEmbeddings), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    token: blobToken,
  });

  console.log(`\nUploaded ${withEmbeddings.length} chunks to private blob "${BLOB_PATH}".`);
  console.log(
    "No URL to set — it's private. Just make sure BLOB_READ_WRITE_TOKEN is set wherever this " +
      "runs (locally in .env.local, and in Vercel's project env vars for the deployed app)."
  );
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
