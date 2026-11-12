# StackSense Workbench

[Project repository](https://github.com/car-ui/stack-sense)

StackSense Workbench recommends a frontend, backend, database, hosting profile and optional supporting services from structured project requirements. It checks provider and placement rules before scoring eligible designs, estimates a monthly operating band, and shows the inputs, alternatives and trade-offs behind each choice. The browser and CLI run the same deterministic JavaScript engine.

## Run locally

**Prerequisite** — Node.js 22 or later on Windows, macOS or Linux. The project was verified with Node.js 25.3.0 on Windows. Use a current Chrome, Edge, Firefox or Safari for the browser interface. There are no install steps, runtime dependencies, service accounts or keys.

Open a terminal in the directory containing this README and run these commands.

```text
node --version
node server.mjs
```

Open [the local workbench](http://127.0.0.1:4173). The server listens on loopback. If the port is busy, run `node server.mjs 4174` and open port 4174. Press Ctrl+C in the terminal to stop it.

- Select a public case for an immediate recommendation, or choose **Import JSON** and select any single scenario JSON file.
- For a custom case, use **New scenario** and complete the fields marked with an asterisk. Open the collapsed input groups to specify deployment, compliance, features, SLOs and optional refinements. **Raw JSON** shows the same input in the standard format.
- Select **Recommend stack** after editing. Open the disclosures for alternatives, input paths, trade-offs, cost assumptions and default values. **Export JSON** downloads the latest decision to your browser's download location.

## CLI and verification

```text
node cli.mjs scenarios/P2.json --out P2_output.json --no-llm
node cli.mjs scenarios/P6.json
node --test
node benchmark.mjs
```

The first command writes to the chosen path relative to the current directory. The second prints JSON to standard output. Input errors and infeasibility still produce JSON. Exit codes are 0 for a recommendation (including warnings), 1 for invalid CLI syntax, 2 for invalid input, and 3 for infeasibility. A path outside the current directory can be passed as a quoted argument.

No LLM or remote service is part of the engine. The optional `--no-llm` flag is accepted for judge scripts, and its presence leaves the entire output identical. The choices do not use scenario IDs. No environment variables are required.

The benchmark varies provider, deployment model, residency, budget and budget policy across all six public workloads. It verifies the hard constraints and reruns every variant to check determinism. Timings measure the recommendation function after module load.

## Architecture

```text
   Guided form / JSON file                 Scenario JSON
            |                                   |
    Local browser app                          CLI
            +-----------------+-----------------+
                              |
                     schema.mjs validation
                              |
                       engine.mjs policy
                              |
             +----------------+----------------+
             |                                 |
       fit.mjs scoring                  services.mjs
    catalogue + region filter          support + cost band
             |                                 |
             +----------------+----------------+
                              |
              decision record / JSON export
```

| Path | Responsibility |
| --- | --- |
| `schema.mjs` | Shared input definitions, strict types and ranges, default recording |
| `engine.mjs` | Residency policy, contradictions, lifecycle flags, scenario assumptions and result contract |
| `catalog.mjs` | Technology records, deployment profiles and technical references |
| `fit.mjs` | Frontend and runtime scoring, database compatibility and regional host ranking |
| `services.mjs` | Conditional supporting components and explainable monthly band |
| `recovery.mjs` | Recovery profiles, fault-domain compatibility and restore-drill instructions |
| `architecture.mjs` | Architecture rationale, request and data paths, and alternatives |
| `cli.mjs`, `server.mjs`, `web/` | File interface, local static asset server and browser workbench |
| `scenarios/`, `engine.test.mjs` | Official public inputs and regression checks |

## Input contract

The engine accepts Section 3 of the StackSense problem statement. Copy one file from `scenarios/` to start. Keep `requirements.availability` as a string and use lower-case enum values and language names. Optional fields omitted from the file are recorded in `assumptions`. Unknown extra fields are accepted and ignored.

Twelve optional fields refine a scenario.

| Field | Values and effect |
| --- | --- |
| `context.peak_requests_per_second` | Nonnegative integer that overrides the concurrent-client sizing proxy |
| `context.peak_day_requests` | Nonnegative busiest-day request forecast. Evaluates headroom for quota-limited public APIs. |
| `context.budget_policy` | `soft` (default) or `hard_cap`. Hard cap filters policy-compatible profiles using the top of the modeled cost band. |
| `context.recovery_point_minutes` | Nonnegative integer or null. Maximum tolerable loss of committed data. |
| `context.recovery_time_minutes` | Positive integer or null. Maximum tolerable service downtime. |
| `context.recovery_scope` | `zone_outage` (default) or `region_outage`. Determines the failure domain the profile has to cover. |
| `context.data_classification` | `unspecified` (default), `public`, `internal` or `sensitive`. Internal and sensitive data require an identity path and are excluded from public-only profiles. Sensitive data adds key management and audit retention. |
| `context.monthly_egress_gb` | Nonnegative number for monthly internet transfer. Adds a per-GB estimate to regional hosting and checks the GitHub Pages soft limit. |
| `context.search_corpus_gb` | Nonnegative size of indexed text. Separates media storage from search and can move a dynamic workload from native indexes to dedicated search. |
| `context.vendor_lock_in` | `low`, `medium`, `high`. Low tolerance rewards portable container profiles and PostgreSQL JSONB over proprietary document APIs when appropriate. |
| `context.data_profile` | `general`, `relational`, `document`, `time_series`. Documents make eligible nonrelational profiles competitive; relational invariants take precedence |
| `context.residency_region` | Name an approved local site when `data_residency` is `other`. Arbitrary cloud geographies require extending and verifying the catalog |

The cost range is illustrative. It excludes labor, taxes, hardware purchase, transaction fees and unmodeled traffic. Each eligible profile uses the cost of its selected supporting services. The decision report and JSON trace show competing hosting profiles, rejected options and the scoring differences behind ranked alternatives.

**Why this architecture** explains the deployment style, names its input drivers, traces requests and durable state, and compares an alternative. The collaboration profile identifies the API and socket paths separately and uses compatible components for fanout and binary document persistence.

A small public read-heavy API can qualify for Cloudflare Workers Free and D1 Free when its data, traffic, features, skills and policy fit the documented profile. The planner reserves headroom below published account quotas. Confirm public-data scope, CPU time and query scans before launch.

**Data boundary and launch checks** identifies the planned region, core data services and controls that require confirmation. Provider scope links are evidence to check against the exact tier, service features and contracts. Activate regulated data flows and external processors only after the corresponding checks pass.

**Recovery plan and drill** appears when recovery goals are supplied. The engine keeps these targets independent of the availability percentage. Short zonal windows can require synchronous managed PostgreSQL and redundant app capacity. The regional profile supports a scoped AWS HTTP service and RDS PostgreSQL in a catalogued same-geography region pair, with warm capacity and replication included in the cost estimate. The plan records what to test before relying on the objectives.

## Technology and credits

- Node.js 22+ standard library, ECMAScript modules, HTML, CSS and DOM APIs. No external dependencies or runtime APIs.
- The six public input fixtures come from Appendix A of the StackSense Challenge problem statement v1.0, IIIT Bangalore. [Official competition listing](https://unstop.com/hackathons/stacksense-challenge-synergy-26-international-institute-of-information-technology-iiit-bangalore-1762891/amp)
- Catalog product references are attached to entries in `catalog.mjs`. The report lists provider prices, capability docs and policy references.
- OpenAI Codex assisted with implementation, research collection, tests and report preparation. The report and decision policy are a working draft for participant review and ownership before submission.
