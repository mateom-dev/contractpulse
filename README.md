# ContractPulse

**API and event schema compatibility checks.** ContractPulse compares versions of an API or event contract, finds which registered consumers could break, and produces a CI report showing the exact rule behind each finding.

> **Status:** early development, following a 12-week roadmap (see below). It works on local contract files and synthetic consumers.

## The problem

A producer's tests can pass while an API or event change breaks downstream clients. Before merging a contract change, teams need to know:

- is this change safe, breaking, or impossible to judge from the schema alone?
- does it break requests, responses, or both?
- which known consumers depend on the affected fields?

ContractPulse answers these in the terminal and in pull request checks.

## Demo workflow

1. In a fictional `orders.created` event, change `orderId` from string to number
2. Remove a field that consumers expect
3. See the rule findings for each change
4. See the two registered consumers the change affects
5. Read the generated pull request report

## Planned features

- Import of local OpenAPI and JSON Schema files, with stable hashes and bounded reference resolution
- CLI that classifies supported changes as SAFE, BREAKING or UNKNOWN
- Separate compatibility checks for requests and responses
- Registry of consumers mapped to contract versions, with impact reports
- JSON and Markdown report exports
- Pull request checks in an authorized test repository
- Time-limited waivers with audit history

## Tech stack

| Layer | Technology |
|---|---|
| CLI and compatibility engine | TypeScript |
| Frontend | Next.js |
| API | Fastify |
| Database | PostgreSQL, Prisma |
| Testing | Vitest, Playwright |
| Packaging | Docker |

## Architecture

```mermaid
flowchart LR
  Files[Contract files] --> Parse[Bounded parsing + canonicalization]
  Parse --> Rules[Directional rules]
  Rules --> Impact[Consumer impact]
  Impact --> Out[CLI or PR report]
```

**Core entities:** Service, Contract, ContractVersion, Consumer, Dependency, CompatibilityRule, Difference, AnalysisRun, Waiver, PullRequestCheck.

## Design rules

- Unsupported schema constructs are reported as UNKNOWN, never guessed.
- Remote references are never fetched, and input size and depth are limited.
- Reports only claim impact on registered consumers.
- Expired waivers stop bypassing the policy automatically.
- The core engine runs locally without a database.

## Roadmap

| Weeks | Focus |
|---|---|
| 1–2 | CLI, CI and sample contracts; bounded parsing, canonicalization and hashing |
| 3–4 | Type-change, field-removal and requiredness rules; readable diffs and CLI output |
| 5–6 | Registry for services and contract versions; consumer dependencies and impact |
| 7–8 | Version and impact UI, report exports; auditable waivers with expiry |
| 9–10 | Pull request checks; more golden test cases and unsupported-form docs |
| 11–12 | Size limits, benchmarks, packaging, end-to-end tests and docs |

## Getting started

Setup instructions will be added once the CLI is in place.
