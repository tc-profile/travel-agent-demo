"""
Knowledge base ingestion for the search_knowledge_base tool.

Chunks and embeds every .txt/.md/.pdf file in knowledge_base/ and stores the
result in a local, persisted Chroma vector store (.chroma_db/), rebuilding
the collection from scratch each run.

Run whenever knowledge_base/ changes:
    python ingest.py
"""

import os
import sys
from pathlib import Path

import chromadb
import voyageai
from dotenv import load_dotenv
from pypdf import PdfReader

load_dotenv(os.path.join(os.path.dirname(__file__), "config.env"))

KB_DIR = Path(__file__).parent / "knowledge_base"
CHROMA_DIR = Path(__file__).parent / ".chroma_db"
COLLECTION_NAME = "knowledge_base"
EMBED_MODEL = "voyage-3.5-lite"
CHUNK_SIZE = 800
CHUNK_OVERLAP = 150


def read_text(path: Path) -> str:
    if path.suffix.lower() == ".pdf":
        reader = PdfReader(str(path))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    return path.read_text(encoding="utf-8")


def chunk_text(text: str, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Fixed-size character chunking with overlap. Good enough for a demo corpus."""
    collapsed = " ".join(text.split())
    chunks = []
    start = 0
    while start < len(collapsed):
        end = start + size
        chunks.append(collapsed[start:end])
        start = end - overlap
        if start <= 0:
            break
    return [c for c in chunks if c.strip()]


def main():
    api_key = os.environ.get("VOYAGE_API_KEY")
    if not api_key:
        print(
            "VOYAGE_API_KEY is not set.\n"
            "Add it to config.env (get a free-tier key at https://dash.voyageai.com/), then re-run."
        )
        sys.exit(1)

    files = sorted(
        p for p in KB_DIR.glob("*") if p.is_file() and p.suffix.lower() in {".txt", ".md", ".pdf"}
    )
    if not files:
        print(f"No .txt/.md/.pdf files found in {KB_DIR}")
        sys.exit(1)

    ids, documents, metadatas = [], [], []
    for path in files:
        chunks = chunk_text(read_text(path))
        for i, chunk in enumerate(chunks):
            ids.append(f"{path.name}::{i}")
            documents.append(chunk)
            metadatas.append({"source": path.name})

    print(f"Embedding {len(documents)} chunks from {len(files)} file(s): {', '.join(p.name for p in files)}")
    voyage = voyageai.Client(api_key=api_key)
    result = voyage.embed(documents, model=EMBED_MODEL, input_type="document")

    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    existing = {c.name for c in client.list_collections()}
    if COLLECTION_NAME in existing:
        client.delete_collection(COLLECTION_NAME)
    collection = client.create_collection(COLLECTION_NAME)
    collection.add(ids=ids, embeddings=result.embeddings, documents=documents, metadatas=metadatas)

    print(f"Indexed {len(documents)} chunks into {CHROMA_DIR}/")


if __name__ == "__main__":
    main()
