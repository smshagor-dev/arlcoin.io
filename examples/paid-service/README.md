# A paid service on ARL, in five minutes

A small HTTP service that is paid through an escrow on Base Mainnet. A caller pays into the escrow
first, the service does the work, and the money reaches the service only after staked validators
have re-run the work and got the same result. One file, two dependencies.

## Start

```sh
npx degit armanalabsai/arlcoin.io/examples/paid-service my-service
cd my-service
npm install
npm run check
```

`npm run check` needs no key and no network. It prints what the service sells: the hash of the job
(`specHash`), the hash of its result (`deliverable`), the price and the validators.

```json
{
  "specHash": "0xd19bf72f563be778f889d5e53d9307e161eee956ba1d98256e6a8818f18ae9e8",
  "deliverable": "0x14314125a6090f687695d2fb06cac04cce830d8a3ec06b9c938ed8ec086efd73",
  "priceArl": "100"
}
```

## Run it

1. Publish `spec.json` where it can be read over https (your repository, a gist) or on IPFS.
2. Start the service with the account that is paid and the link to the spec:

```sh
ARL_SERVICE_KEY=0x... ARL_SPEC_URL=https://.../spec.json npm start
```

A request without a paid job gets `402` with the terms. A caller pays and gets the answer with one
call of the SDK:

```ts
import { payVerified } from "arl-protocol-sdk";
import { parseUnits } from "viem";

// clients: the caller's own viem publicClient and walletClient on Base.
const { response, jobId } = await payVerified(clients, "http://localhost:8787/", {
  maxBudget: parseUnits("100", 18), // the most this caller agrees to escrow
});
console.log(jobId, await response.json()); // { summary: "passed=3 failed=0" }
```

`payVerified` reads the terms, opens and funds a job that matches them and asks again. The service
checks the job on chain, approves the validators, does the work, answers, and submits the result's
hash. The validators re-run `spec.json`; after the challenge window the escrow pays the service.
If the validators get another result, or the service never delivers, the caller gets the budget
back.

## Make it yours

Two things define the service, and they must agree:

- **`spec.json`** is the job as a validator re-runs it: a container image pinned by digest, the
  command, the files it writes to `/out`, and its limits. The container has no network.
- **`work()` in `server.mjs`** is the same job, done by you. It returns the same files with the
  same bytes, and the answer for the caller.

Change both, then run `npm run check` again. To see what a validator will compute, run the spec in
Docker with the reference verifier and compare its `deliverable` with yours:

```sh
git clone https://github.com/armanalabsai/arlcoin.io && cd arlcoin.io && npm ci
node packages/verifier/src/cli.ts run /path/to/my-service/spec.json
```

The example spec was run this way: Docker gives the same `deliverable` as `npm run check`.

## Settings

| Variable          | Meaning                                                      | Default                     |
| ----------------- | ------------------------------------------------------------ | --------------------------- |
| `ARL_SERVICE_KEY` | Private key of the account that is paid                      | required                    |
| `ARL_SPEC_URL`    | Public link to `spec.json`                                   | required                    |
| `ARL_PRICE`       | Price per call, in ARL                                       | `100`                       |
| `ARL_COMMITTEE`   | Validator addresses, separated by commas (at least three)    | ARL's validators            |
| `ARL_RPC`         | Base Mainnet endpoint                                        | `https://mainnet.base.org`  |
| `PORT`            | Port to listen on                                            | `8787`                      |

Validators lock a bond of 100 ARL for a job and take it only when the budget is at least that, so
100 ARL is the lowest price that is checked. The account that is paid needs a little ETH on Base
for gas: it sends two transactions per job.

Served jobs are remembered in memory. A service that restarts, or runs more than one instance,
passes a durable store as `usedJobs` (see `payOnProof` in the
[SDK](https://www.npmjs.com/package/arl-protocol-sdk)).

## More

- How a verified job works, step by step, without a wallet: [arlcoin.io/demo](https://arlcoin.io/demo/)
- The same wrapper in Next.js, Hono or a Cloudflare Worker, and in Python (`PayOnProof`):
  [arlcoin.io/build](https://arlcoin.io/build/)
- The validators and the contracts, live: [arlcoin.io/status](https://arlcoin.io/status/)
