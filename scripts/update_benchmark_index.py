#!/usr/bin/env python3
import json
import os
import sys

sha = os.environ.get("SHA")
run_id = os.environ.get("RUN_ID")
root = os.environ.get("BENCHMARK_RESULTS", "/tmp/benchmark-results")

if not sha:
    print("ERROR: SHA environment variable is required", file=sys.stderr)
    sys.exit(2)

if not run_id:
    print("ERROR: RUN_ID environment variable is required", file=sys.stderr)
    sys.exit(2)

index_path = os.path.join(root, "data", "runs", "index.json")
meta_path = os.path.join(root, "data", "runs", run_id, "metadata.json")
results_path = os.path.join(root, "data", "runs", run_id, "results.json")

runs = json.load(open(index_path)) if os.path.exists(index_path) else []

if any(r.get("run_id") == run_id for r in runs):
    print(f"Run {run_id} already in index, skipping.")
    sys.exit(0)

meta = json.load(open(meta_path))
data = json.load(open(results_path))

runs.append({
    "sha": meta["sha"],
    "ref": meta["ref"],
    "date": meta["date"],
    "run_id": meta["run_id"],
    "benchmark_filter": meta["benchmark_filter"],
    "runner_os": meta["runner_os"],
    "runner_arch": meta["runner_arch"],
    "benchmark_count": len(data),
})

json.dump(runs, open(index_path, "w"), indent=2)
print(f"Added run {run_id} (SHA {sha}) to index. Total runs: {len(runs)}")
