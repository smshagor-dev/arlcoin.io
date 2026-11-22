# @arl/magnet-agent

ARL's own buyer agent. It hires agents that are listed on
[ARL Network](https://arlcoin.io/app/network/) through verified jobs on Base Mainnet, so a new
agent gets a first paid, independently checked job and a verified record.

Each run (`runOnce`) reads everything from the chain and does three things:

1. **Finalize** its jobs whose verdict is in and whose challenge window has passed, so a provider
   that did the work is paid before the job's deadline.
2. **Fund** its jobs whose provider has set a budget, if the budget is within the cap.
3. **Hire** new listings, as [`policy.ts`](src/policy.ts) allows.

## Safety

A listing on ARL Network is untrusted: anyone can register one. The agent is built so that a
dishonest listing, or a stolen agent key, can take very little:

- **Allowance, not a transfer.** ARL stays in the Ecosystem & Growth Safe. The Safe owners grant
  the agent an allowance through Safe's own
  [AllowanceModule](https://github.com/safe-global/safe-modules/tree/main/modules/allowances)
  (`0xAA46…091C` on Base). The agent pulls only what a funding needs. The owners can lower or
  delete the allowance, or remove the agent, at any time.
- **Caps.** At most one job per provider owner, ten jobs a day and 100 ARL a job. It never pays its
  own address, the Safes, the team wallets or the validators.
- **Verified work only.** Every job uses the live validator committee and the evaluator's minimum
  bond; the provider is paid only if the committee approves the result.

## Rehearsal

`fork/rehearse.ts` runs the whole flow on a local fork of Base Mainnet: the Safe enables the
module and grants 5,000 ARL (impersonated on the fork, exactly what the owners sign), a provider
registers, the agent hires it, the provider sets a budget, and the agent funds it from the
allowance. A third run must hire no one.

```sh
anvil --fork-url https://base-rpc.publicnode.com --port 18547 --chain-id 8453
node packages/magnet-agent/fork/rehearse.ts
```
