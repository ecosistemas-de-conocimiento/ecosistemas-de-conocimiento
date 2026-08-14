"""Build-time model bake.

Run during ``docker build`` (see Dockerfile) so the bge-m3 weights are downloaded
into the image's HF cache layer — NOT fetched on first request. It reuses the
SAME loader + warmup as the running service, so what gets baked is exactly what
boot will load (no drift). ``warmup`` also resolves every lazily fetched file so
the runtime can run fully offline.
"""

from app import BGE_M3_MODEL, load_model, warmup

if __name__ == "__main__":
    print(f"[bake] downloading + warming embedder {BGE_M3_MODEL} ...", flush=True)
    load_model()
    warmup()
    print("[bake] done — weights cached in the image", flush=True)
