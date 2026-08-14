"""Build-time model bake.

Run during ``docker build`` (see Dockerfile) so the reranker weights are
downloaded into the image's HF cache layer — NOT fetched on first request. It
reuses the SAME loader + warmup as the running service, so what gets baked is
exactly what boot will load (no drift). ``warmup`` also resolves every lazily
fetched file so the runtime can run fully offline.
"""

from app import RERANK_MODEL, load_reranker, warmup

if __name__ == "__main__":
    print(f"[bake] downloading + warming reranker {RERANK_MODEL} ...", flush=True)
    load_reranker()
    warmup()
    print("[bake] done — weights cached in the image", flush=True)
