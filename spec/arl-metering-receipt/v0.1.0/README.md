# Verifiable resource metering receipt (`arl-metering-receipt/1`)

**Specification draft:** v0.1.0 · **Issue:** [#329](https://github.com/armanalabsai/arlcoin.io/issues/329) · **Scope:** trusted-host software metering only.

**Security limitation:** An authorized meter signature authenticates a report and binds it to a job; it does **not** attest that a compromised host actually consumed the reported resources. This specification is not a TEE, GPU attestation, billing, or settlement protocol.

This first specification PR fixes the wire format, hashing rules and reproducible cryptographic fixtures for review. The reference runner, authenticated ERC-8004 registration resolver, independent verifier and Anvil integration belong to later PRs. The registration extension namespace and precise replay storage policy are **proposals pending upstream confirmation**, not already deployed behavior.

## 1. Model and relationship to existing ARL documents

A provider submits the canonical hash of an `arl-reexec-result/1` manifest as its deliverable. A validator independently re-executes the committed `arl-reexec/1` spec and computes the result manifest and its hash. A provider-controlled meter (or a meter explicitly authorized for the submitting provider) emits a receipt for one measured execution, signed using its *separate* per-meter EOA key. The validator verifies the provider's signed receipt and registry binding **before** voting, and separately re-executes the committed spec to establish result correctness. The validator must not receive or reuse the provider's meter private key.

Three hashes have distinct jobs:

1. `receipt_hash = canonicalHash(receipt)` authenticates the **receipt payload only**, excluding its signature and any transport wrapper.
2. `typed_data_digest = hashTypedData(domain, MeteringReceipt, message)` is EIP-712, with the receipt hash and explicit job bindings; it is **not** the canonical hash.
3. `composite_evidence_hash = canonicalHash({version: "arl-metering-vote/1", result_hash, receipt_hash})` is the `bytes32 evidence` passed to the existing evaluator `vote(jobId, approve, deliverable, evidence)` ABI; it is neither of the previous two hashes.

The existing `ARLVerifiedEvaluator` contract records `evidence` and emits it in `Voted`; it does not verify the receipt off-chain and must not be described as doing so. No contract or deployed-address changes are made.

## 2. Receipt JSON

A receipt contains **exactly** the following fields. Unknown keys and missing keys are errors. JSON numbers are integers in `[0, 9007199254740991]` (`Number.MAX_SAFE_INTEGER`), not strings, except `job_id` which is the canonical decimal encoding of a uint256. No float, exponent-encoded non-integer, negative zero, `NaN`, `Infinity`, `undefined`, or `bigint` is valid on the wire.

| Field | Type | Required meaning and validation |
|---|---|---|
| `version` | string | Exactly `arl-metering-receipt/1` |
| `chain_id` | JSON integer | Positive, safe integer, actual authenticated RPC chain ID |
| `evaluator_address` | address | `0x` plus 40 hex digits; equals the evaluator named on-chain by the job; case-normalize to lowercase **before signing** |
| `job_id` | decimal string | Canonical unsigned uint256: `0` or `[1-9][0-9]*`, no leading zeros or whitespace, bounded by `2^256-1` |
| `spec_hash` | bytes32 | Lowercase `0x` + 64 hex; matches evaluator's committed `specHash` |
| `deliverable_hash` | bytes32 | Lowercase `0x` + 64 hex; matches the submitted deliverable for the same job |
| `run_id` | bytes32 | Fresh cryptographically random 32-byte run identifier |
| `nonce` | bytes32 | Fresh cryptographically random 32-byte per-meter nonce; unique under replay policy |
| `container_digest` | string | Must equal the validated `ReexecSpec.container_digest` (pinned `name@sha256:<64 lowercase hex>`) |
| `meter_version` | string | Nonempty, bounded version identifier of the metering implementation; v0.1 proposal: ASCII 1–128 chars |
| `meter_source` | string | Measurement origin; initial reference source `linux-cgroup-v2` (see section 6) |
| `trust_level` | string | Exactly `trusted-host/software` |
| `started_at` | JSON integer | UTC Unix seconds at measured execution start |
| `finished_at` | JSON integer | UTC Unix seconds at measured execution finish |
| `elapsed_ns` | JSON integer | Monotonic elapsed duration, nanoseconds, nonnegative |
| `cpu_time_ns` | JSON integer | Aggregate container process CPU time, nanoseconds, nonnegative |
| `memory_peak_bytes` | JSON integer | Peak container cgroup memory consumption, bytes, nonnegative |
| `gpu_metrics` | null | Exactly JSON `null` while GPU counters are unsupported in Phase 1; never use zero as a stand-in |

`started_at <= finished_at`. The monotonic duration must be consistent with the coarse Unix-second timestamps: `abs(elapsed_ns - (finished_at - started_at) * 1_000_000_000) < 2_000_000_000`. The independent verifier additionally applies configured maximum-duration, clock-skew and measurement-range policy. Clock adjustments during a run that break the consistency condition produce an invalid receipt rather than an invented correction.

**Integer interoperability:** Validate the exact parsed JSON shape before canonicalization. Do not round unsafe integers and do not turn large numbers into scientific notation or decimal strings. The existing `packages/verifier/src/canonical.ts` refuses numbers that are not safe integers and omits `undefined` object members; therefore the receipt schema validation **must** detect missing keys first. Large on-chain job IDs are strings in JSON and are encoded as `uint256` in typed data using a bigint parser. The JSON document should not include a billable duration: metered consumption is independent of price and invoicing.

## 3. Canonical receipt hash and transport envelope

The receipt payload is canonicalized **exactly** with the existing `packages/verifier/src/canonical.ts` `canonicalize()` function: object keys sorted by JavaScript UTF-16 code units, strings as `JSON.stringify`, no whitespace, safe integer numbers only, preserved array order. Hash the UTF-8 bytes with `keccak256` using `canonicalHash(receipt)`; this is not generic SHA3-256. Cross-language implementations must reproduce the same escaping and key order. Do not add signature fields inside the payload and do not canonicalize the JSON transport envelope.

The transport envelope has the exact form:

```json
{
  "receipt": { "version": "arl-metering-receipt/1" },
  "signature": "0x<65 bytes: r || s || v>"
}
```

The example abbreviates the receipt for readability only; a real receipt has **all** required fields. `signature` must be a 65-byte recoverable secp256k1 ECDSA signature with low-S normalization and valid recovery parity. No self-reported signer address is accepted as an authorization source. An optional envelope `receipt_hash` assertion, if introduced by an API, is untrusted and must be recomputed and compared.

## 4. EIP-712 signed commitment

The approved EIP-712 *proposal* uses the following exact domain and type (the types must be agreed before published production signatures are relied upon):

```ts
const domain = {
  name: "ARL Verifiable Resource Metering",
  version: "1",
  chainId: receipt.chain_id,
  verifyingContract: receipt.evaluator_address,
} as const;

const types = {
  MeteringReceipt: [
    { name: "receiptHash", type: "bytes32" },
    { name: "jobId", type: "uint256" },
    { name: "specHash", type: "bytes32" },
    { name: "deliverableHash", type: "bytes32" },
    { name: "runId", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const message = {
  receiptHash: canonicalHash(receipt),
  jobId: BigInt(receipt.job_id),
  specHash: receipt.spec_hash,
  deliverableHash: receipt.deliverable_hash,
  runId: receipt.run_id,
  nonce: receipt.nonce,
} as const;
```

The EIP-712 digest is `keccak256(0x1901 || domainSeparator || hashStruct(MeteringReceipt, message))`. A meter signs the digest using its **per-meter** key, never a validator wallet or provider treasury key. The verifier rejects wrong chain, evaluator, job, specification, deliverable, run identifier, nonce or receipt payload even if a receipt contains a plausible-looking signature. Addresses and bytes32 strings are normalized and validated **before hashing**, not silently repaired during verification.

The registration is independently authenticated. A receipt's `signature` proves possession of some private key, but it only becomes authorized after an authenticated resolver identifies **the expected meter address**.

## 5. Signer registration and replay policy (pending team agreement)

**Proposed resolution:** Read the job's `provider` from `ARLJobs.getJob` and `providerAgentId` from `ARLVerifiedEvaluator.getConfig` on the intended chain. For nonzero agent ID, obtain the ERC-8004 identity registry from trusted chain configuration, verify `ownerOf(agentId)` against the bound job provider as applicable to ARL's configuration, retrieve `tokenURI(agentId)` / `agentURI`, and read its registration file at a pinned URI/hash or a specified authenticated block. The registry controls which signing key is expected. The *proposed*, ARL-specific extension is:

```json
{
  "extensions": {
    "arl-metering-receipt/1": {
      "signer": "0x<authorized per-meter address>"
    }
  }
}
```

**This is a proposed namespace, not an asserted ERC-8004 standard field.** The upstream team needs to confirm its placement, authorization process, historical key-rotation policy, and a binding strategy against mutable HTTPS metadata. The `agentWallet` value alone is **not** automatically a per-meter signing key. A job with agent ID zero, an unreachable registry, unverifiable ownership, absent metadata or ambiguous history must **fail closed for metered approval**, unless the local Anvil demonstration explicitly uses an authenticated, test-only registration fixture.

Stateless verification rejects a receipt bound to another chain/evaluator/job/spec/deliverable, but cannot know whether an otherwise valid signed receipt was already accepted. Enforce durable, atomic uniqueness over `(chain_id, evaluator_address, job_id, expected_signer, nonce)` and a **one accepted receipt per configured validator re-execution/run policy**. Persist decisions across restarts; prohibit duplicate `run_id`, and define an explicit retry/rotation policy. A local test in-memory store is not production replay protection. Retrieval from a different metadata block must not retrospectively authorize old signatures.

### Receipt producer and transport: unresolved integration choice

The current `ARLJobs.submit` records a `bytes32 deliverable`, not a metering document; the existing `JobSubmitted` log and `packages/verifier/src/chain.ts` do not provide a signed-receipt URI. The team must agree on how validators discover the **provider-produced** envelope (for example, an authenticated sidecar discoverable by chain/evaluator/job ID) and how availability, integrity, size limits and replay are handled without a contract change. Receipt retrieval is untrusted until its signature and registered meter identity verify. A receipt for a provider run cannot be represented as though it measured a validator's separate re-execution: the two resource usages will differ. Conversely, if the desired signed receipt represents a validator-owned run, the requirement to resolve the signer from the **provider's** ERC-8004 registration must be clarified; a validator cannot safely use the provider's private metering key.

This is a **protocol decision blocker for PR 2**, not a reason to silently invent a network endpoint or embed the meter key inside the validator.

## 6. Measurement semantics and lifecycle

The initial reference design targets **Linux Docker with cgroup v2**, not the Node.js process hosting the Docker CLI. Obtain container-level `cpu.stat usage_usec` (sum across child processes, convert microseconds to nanoseconds) and `memory.peak` (peak cgroup consumption in bytes). Use a fresh container cgroup per run. `process.hrtime.bigint()` measures monotonic elapsed time; `Date.now()` provides integer Unix-second start and finish timestamps. All readings must refer to the same execution interval. CPU may exceed elapsed wall time on multicore workloads; do not equate the two. `memory.peak` is a cgroup memory metric, not an exact application heap or resident-set peak. Capture final counters **before** removing the container; do not mistake sampled `docker stats` for an exact peak. See the upstream Docker cgroup documentation for accounting differences.

Pulling an image, fetching inputs, billing and post-execution output hashing are **outside** this first meter's measured interval; only the single re-execution container is measured. An execution that is timed out, cancelled, or fails must not produce an apparently successful receipt. A separately marked failed-run record may be retained for audit, but must not enter a positive metering vote. Propagate cancellation into the actual container lifecycle; the existing `execute(signal)` checks only between stages, and the current `ContainerRunner.run()` signature does not accept a signal or return counters. These are later-PR integration gaps.

If process-tree accounting, cgroup counters, timestamps or final peak cannot be collected, the meter must fail rather than fabricating zero consumption. Unsupported GPU counters are explicitly `null`.

## 7. Composite validator vote evidence

Once the independent verifier has accepted a signed receipt, the validator constructs exactly:

```json
{
  "version": "arl-metering-vote/1",
  "result_hash": "0x<32-byte re-execution result hash>",
  "receipt_hash": "0x<32-byte canonical receipt hash>"
}
```

`result_hash` is the **validator's recomputed** `resultHash(result)`; it must not be copied from the receipt without recomputation. For a positive vote, it equals the submitted deliverable. The call `castVote(..., canonicalHash(composite))` passes this composite hash to `ARLVerifiedEvaluator.vote` without ABI or contract modifications. The existing on-chain `Voted` event exposes that 32-byte hash. A downstream auditor must obtain the canonical receipt and evidence separately; a bare hash alone does not include them.

**Open policy question:** The current keeper may cast a reject vote with a failure hash when a re-execution fails near its deadline. The team must decide whether the new metering mode allows that legacy rejection evidence or mandates a distinct versioned failure evidence form. The implementation must never label an unverified receipt as approved.

## 8. Deterministic fixtures and validation

`vectors.json` pins a local-only signed receipt, its authorized test signer, its canonical receipt hash, EIP-712 digest, signature, composite vote and composite evidence hash. It includes mutation cases for tampering, binding mismatch, malformed measurements and replay. The vector key is derived only from the public string `arl-metering-test-vector-only-not-private`; it is **not** a production secret. Hash and signature fixtures were independently generated for the draft; before merging, they must also pass the repository's TypeScript `viem` tests and CI.

The invalid fixtures supply the **expected rejection category** to be implemented by the later verifier; PR 1 checks the available canonical and cryptographic properties but does **not** claim to implement full receipt verification.

Expected verifier error categories: `MALFORMED_RECEIPT`, `UNSUPPORTED_VERSION`, `MISSING_FIELD`, `UNSAFE_INTEGER`, `INVALID_MEASUREMENT`, `INVALID_TIMESTAMP`, `INVALID_GPU_METRICS`, `UNSUPPORTED_METER_SOURCE`, `REGISTRATION_UNAVAILABLE`, `SIGNER_MISMATCH`, `SIGNATURE_INVALID`, `CHAIN_MISMATCH`, `EVALUATOR_MISMATCH`, `JOB_MISMATCH`, `SPEC_MISMATCH`, `DELIVERABLE_MISMATCH`, `REPLAY_DETECTED`, `COMPOSITE_MISMATCH`.

Negative tests must also cover malleable/high-S signatures, duplicate JSON keys, duplicate receipts, nonce collisions, overflow, missing metadata, unverifiable registry updates, and unauthenticated HTTPS registration files.

**ECDSA diagnostic ordering:** A changed receipt payload generally recovers a *different* public key from the original signature, so the independent verifier reports `SIGNER_MISMATCH` for those cases. `SIGNATURE_INVALID` is reserved for nonrecoverable, malformed, high-S or invalid-recovery signatures. This distinction is diagnostic, not a difference in acceptance: both fail closed. JSON parsers that accept duplicate keys cannot merely accept the last value; raw parsing or duplicate-key-aware validation is required.

## 9. Verification boundary and rollout

- **PR 1:** This specification, test vectors, and TypeScript tests for canonical and typed-data compatibility. No runtime behavior is enabled.
- **PR 2:** Authenticated registration resolution, metering runner, independent verifier, durable replay policy, cancellation and failure hardening.
- **PR 3:** Composite evidence in the validator, CLI/watch integration, one-command Anvil demonstration, operational documentation and complete failure-path tests.

Before merging PR 1, agree on the EIP-712 type and domain, registration extension format and historical authenticity, nonce scope, failed-run evidence policy, and exact platform requirements. The accepted protocol cannot claim hardware attestation or use receipt measurements to calculate payment within this phase.