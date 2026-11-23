# arl-research-log/1 (v0.1.0)

Status: **v0.1.0**, 23 November 2026. Reference validator:
[`packages/verifier/src/research.ts`](../../../packages/verifier/src/research.ts).

How a provider delivers a sourced research brief under
[`arl-policy/1:research-sources`](../../arl-policy/v0.1.0/README.md), and how a validator checks it.
Nothing on chain changes: the job runs on the same `ARLJobs` and `ARLVerifiedEvaluator` contracts.

## What the provider publishes

1. **The brief** (the deliverable, `text/markdown`). Every factual claim cites its source as `[n]`
   (or `[n, m]`), where `n` is a source `id` in the research log. Markdown links are not citations.
2. **The research log** (`logs` evidence, `application/json`):

```json
{
  "version": "arl-research-log/1",
  "sources": [
    {
      "id": 1,
      "url": "https://example.org/report",
      "sha256": "<64 lowercase hex: SHA-256 of the bytes the provider read>",
      "quote": "a short verbatim passage of the source that supports the claim"
    }
  ]
}
```

| Field              | Rule                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| `version`          | `"arl-research-log/1"`                                                          |
| `sources`          | 1 to 32 items; unknown fields are refused                                       |
| `sources[].id`     | integer 1 to 999, unique                                                        |
| `sources[].url`    | `https://` only                                                                 |
| `sources[].sha256` | SHA-256 of the fetched bytes at the provider's read time                        |
| `sources[].quote`  | 20 to 1,000 characters, copied verbatim from the source's readable text         |

3. **The proof** (`arl-proof/1`): the brief as `deliverable`, the evidence the task requires
   (`artifact`, `model-verdict`, `logs` for the template), each with its SHA-256.
4. **The submission**: `ARLJobs.submit(jobId, proofHash, bytes(proofUri))`, called directly by the
   provider. The deliverable is the proof hash; the third argument carries the proof's `https://` or
   `ipfs://` URI, which validators read from the transaction.

## What a validator checks

Before accepting: the task fetches, its hash equals the one in the job description and the
evaluator's committed `specHash`, and it names `arl-policy/1:research-sources`.

Before voting, it fetches the proof from the submission, checks that it hashes to the on-chain
deliverable and fits the task (`checkProofAgainstTask`), then fetches the brief and the log by
their SHA-256 and every source URL itself (public https only, size and time limits). Per
acceptance rule of the template:

| Rule               | Outcome                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `sources-resolve`  | `check`: every source cited in the brief is in the log, and every source URL answers 200     |
| `claims-supported` | `check`: every quote appears in the readable text the validator fetched (case, spacing and typographic quotes normalized) |
| `answers-question` | `model`: a pinned open model the validator runs says the brief answers the task as asked     |

A rule the validator cannot check gets no outcome. The vote follows `decideVote`: approve only if
every rule has an admissible passing outcome; a model verdict is admissible only within the
policy's budget cap (100 ARL or 100 USDC). The vote's evidence is the canonical hash of
`{ version: "arl-research-vote/1", approve, reason, outcomes }`.

Pages change. The validator does not require its own fetch to hash to the provider's `sha256`; it
requires the quote to still be there. A source that has since changed the quoted passage fails
`claims-supported`, which is why a provider should cite stable pages.
