# ARL Verifiable Resource Metering: reference Docker runtime

This is in-progress trusted-host software metering for [Issue #329](https://github.com/armanalabsai/arlcoin.io/issues/329), not a hardware attestation protocol or an upstream-approved implementation.

## Architecture and measurement

The MeteredDockerRunner in packages/verifier/src/metering/runner.ts reuses the existing dockerRunArgs isolation policy (pinned image, no network, read-only root, unprivileged UID, limits and controlled mounts). It supports Linux cgroup v2 with Docker's cgroupfs driver and an operator-delegated cgroup root.

A fresh per-run parent cgroup is created before running Docker. The detached Docker container is assigned beneath this parent with --cgroup-parent. The host reads the parent cpu.stat usage_usec and memory.peak after Docker exits but before removing the parent. These counters are hierarchical and cover the container's process tree. The container is not auto-removed; cleanup runs on success and failure. Missing counters, failed cleanup and an unsupported host fail closed.

The system intentionally does not use sampled docker stats or Node.js CPU counters. Container CPU time is converted from source microseconds to nanoseconds. The monotonic elapsed_ns interval includes some Docker API startup and termination overhead, and is not an exact nanosecond kernel runtime clock. It is independent of pricing and billing. GPU metrics are null.

## Host prerequisites

Docker on Linux commonly uses the systemd cgroup driver. This initial implementation **requires cgroup v2 + cgroupfs** and is **not compatible with a default systemd-driver host**.

Check the runtime using this command:

    docker info --format '{{.CgroupVersion}}/{{.CgroupDriver}}'

Expected: 2/cgroupfs.

The host operator must securely provision a delegated subtree such as /sys/fs/cgroup/arl-metering. The subtree's cgroup.subtree_control must enable cpu and memory; the trusted validator host account must have sufficient permission to create child cgroups. Do not make /sys/fs/cgroup globally writable. Never change the production Docker daemon configuration simply to satisfy this experimental reference runtime.

MeteredDockerRunner requires cgroupRoot to be an absolute trusted subtree under /sys/fs/cgroup. The Docker daemon and validator must address the same kernel cgroup hierarchy. Incompatible namespaces, inaccessible counters or unexpected Docker cgroup configuration cause failure instead of invented measurements.

## Provider and validator boundary

The existing execute() API may return optional Execution.metering. This is separate from ResultManifest and does not alter deterministic resultHash() compatibility.

Only the trusted provider-side runtime should call produceMeteringReceipt(spec, execution, identity) with a separate provider meter private key. The producer requires an accepted, zero-exit run, a matching spec and result commitment, and actual metering fields. It creates cryptographically random run_id and nonce and signs an EIP-712 message.

The validator never holds the provider's meter private key. Signed measurements prove integrity and attribution under the trusted-host assumption, not physical resource consumption against an administrator-controlled host.

An **opt-in provisional resolver** in packages/verifier/src/metering/registration.ts reads the historical evaluator identity registry address, the job's provider and configured ERC-8004 provider agent ID, and the agent owner and tokenURI at a caller-selected registrationBlock. It requires a trusted external SHA-256 commitment to the *exact registration JSON bytes* and checks the registration's identity cross-reference and proposed extensions["arl-metering-receipt/1"].signer field. It rejects missing registration, wrong owner, mutable substituted metadata, malformed JSON, wrong chain and wrong job context. The verifyRegisteredMeteringReceipt wrapper resolves the signer first, then checks the EIP-712 receipt. It does not trust a self-declared signer or an HTTPS URL alone.

The trusted registration block number, SHA-256 commitment source, extension namespace and historical key-rotation policy **still require upstream approval**. This provisional resolver takes untrusted document bytes as an argument and does not fetch arbitrary remote URLs; an authenticated receipt transport is not yet implemented. Never treat a current, mutable metadata URL as an authorization snapshot.

## Validation

Run normal checks:

    npm ci
    npm test -w @arl/verifier
    npm run typecheck
    npm run lint
    npm run format:check

For the gated real-Docker integration test on a preconfigured supported Linux host:

    ARL_METERING_CGROUP_ROOT=/sys/fs/cgroup/arl-metering npm run test:docker -w @arl/verifier

The test runs a pinned BusyBox CPU/memory workload, reads retained counters, signs the receipt using a public deterministic testing key, and verifies the signature and job bindings. It is **not tested or proven passing yet** in the current environment.

## Remaining integration work

The approved execution identity (provider original execution versus validator re-execution), receipt transport, historical ERC-8004 pin and signer-rotation policy, replay policy and failure-evidence representation require upstream confirmation. The live watcher, Anvil vote demonstration and complete CI suite are not yet integrated or verified. The file-backed per-validator replay reservation is provisional and must not be represented as the agreed protocol policy.

No Solidity, deployed address, billing, payment or tokenomics change is part of this work.


## One-command local Anvil demonstration

The standalone local-chain test runs the compiled ARLToken, ARLJobs and ARLVerifiedEvaluator
contracts with the repository's existing ERC-8004 bytecode fixture. It covers identity
registration, provider-signed receipt verification, tampering and registration-pin rejection,
two validators committing identical composite evidence hashes on chain, approval and settlement.

From a host with Node.js 22.18+, npm, Anvil and Foundry installed:

    npm run demo:metering -w @arl/verifier

The script invokes npm ci, builds the existing contracts and runs
packages/verifier/test-anvil/metering.anvil.test.ts on local port 8557. It
does not deploy to Base Mainnet or other public networks. The metering values
in this test are SYNTHETIC in-process fixtures. The test proves the receipt
signature and composite on-chain evidence flow only; it does not validate
physical or kernel-collected CPU/memory usage.

The real host metering acceptance test is separately gated by
ARL_METERING_CGROUP_ROOT on a compatible Linux cgroup v2/cgroupfs Docker host.
Both tests still require actual execution and a passing CI record.

### Explicit metered voting API

The optional voteMeteredJob() API checks the current chain job is Submitted,
that the validator is Accepted, and that the configured spec and submitted
deliverable are accessible. It verifies a historically pinned ERC-8004 provider
registration, recomputes the validator's independent re-execution result,
authenticates the provider meter receipt and reserves the job in the
provisional replay store before calling the existing vote() ABI with the
canonical arl-metering-vote/1 composite evidence hash.

A transaction error after replay reservation leaves a fail-closed marker
requiring explicit operator reconciliation. The production watch loop and
existing default rejection evidence remain unchanged until the upstream
registration pin, receipt delivery, retry and authorization policy is agreed.
