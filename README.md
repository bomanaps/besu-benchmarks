# besu-benchmarks

Continuous benchmarking pipeline for [Hyperledger Besu](https://github.com/besu-eth/besu)'s EVM. Runs the JMH microbenchmark suite in CI, stores results over time, and surfaces trends and regressions through a dashboard.

## Dashboard

Live results: **https://bomanaps.github.io/besu-benchmarks/**

Latest run, per-benchmark trend charts, and run-to-run comparison. Filters for regressions, improvements, and noisy results.

## Running a benchmark

Head to the **[Actions tab](https://github.com/bomanaps/besu-benchmarks/actions)** → **EVM JMH Benchmarks** → **Run workflow**, then fill in:

| Input | What it does |
|---|---|
| `besu_ref` | Branch, tag, or SHA of Besu to benchmark. Defaults to `main`. |
| `besu_repo` | Which Besu repo to clone. Defaults to `besu-eth/besu`. |
| `benchmark_filter` | Optional JMH include pattern (e.g. `AddOperation`). Leave empty to run the full suite. |

The workflow clones Besu at the ref you specify, runs the JMH suite (~2–3 hours on `ubuntu-latest` for the full suite), and commits the results into `data/runs/<besu-sha>/`. The dashboard picks them up on the next page load.
