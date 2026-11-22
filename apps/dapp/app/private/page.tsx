"use client";

import {
  commitment,
  createGroup,
  identityMessage,
  proveSignal,
  secretFromSignature,
  signalInputs,
} from "@arl/zk";
import circuitJson from "@arl/zk/circuit";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState, useSyncExternalStore } from "react";
import { createWalletClient, http, parseEventLogs } from "viem";
import { useAccount, usePublicClient, useSignMessage, useWriteContract } from "wagmi";

import { Facts, NotLiveYet, PageTitle, RequireWallet, Stat } from "~~/components/arl/ui";
import localContracts from "~~/contracts/localContracts";
import { useTargetNetwork } from "~~/hooks/scaffold-eth";
import { ARL, IS_LOCAL, REFRESH_MS, deployBlock } from "~~/lib/contracts";
import { eventsSince } from "~~/lib/logs";
import { DEMO_GROUP, DEMO_GROUP_ADMIN, DEMO_RELAYER, POLL } from "~~/lib/poll";
import {
  PollError,
  optionMessage,
  parseCommitments,
  parsePollQuery,
  pollQuery,
  pollScope,
  tallyPoll,
  type PrivatePoll,
} from "~~/lib/privatePoll";

// The anonymous signals contract of the chain this build targets. Its interface is the same on
// every chain; the address and the deployment block come from the chain's record. Until the
// contract is recorded for Base Mainnet the screen says so.
const ABI = localContracts[31337].ARLAnonymousSignal.abi;
const recorded = (
  ARL as unknown as Record<string, { address: `0x${string}`; deployedOnBlock?: number } | undefined>
).ARLAnonymousSignal;
const SIGNAL = recorded ? { ...recorded, abi: ABI } : undefined;
const circuit = circuitJson as unknown as CompiledCircuit;

/** The demo poll of the local chain: group 0, where development accounts admin and relay. */
const DEMO: PrivatePoll = {
  group: DEMO_GROUP,
  poll: POLL.scope,
  question: POLL.question,
  options: [...POLL.options],
};

type Status =
  | { kind: "idle" }
  | { kind: "busy"; text: string }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

type Link =
  | { kind: "none" }
  // `?tools`: the admin tools, also on the local chain where no link means the demo poll.
  | { kind: "tools" }
  | { kind: "poll"; poll: PrivatePoll }
  | { kind: "broken"; reason: string };

const firstLine = (e: unknown, fallback: string) =>
  e instanceof Error ? (e.message.split("\n")[0] ?? fallback) : fallback;

const noSubscription = () => () => undefined;

/** The poll named by the page's link; `undefined` until the page is in the browser. */
function usePollLink(): Link | undefined {
  const search = useSyncExternalStore(
    noSubscription,
    () => window.location.search,
    () => undefined,
  );
  return useMemo(() => {
    if (search === undefined) return undefined;
    try {
      const poll = parsePollQuery(search);
      if (poll) return { kind: "poll", poll };
      return new URLSearchParams(search).has("tools") ? { kind: "tools" } : { kind: "none" };
    } catch (e) {
      return { kind: "broken", reason: e instanceof PollError ? e.message : "unreadable link" };
    }
  }, [search]);
}

export default function PrivatePage() {
  const link = usePollLink();
  return (
    <>
      <PageTitle title="Private">
        Vote as a member of a group without revealing which member you are. Your browser proves
        membership with a zero-knowledge proof; the contract checks the proof and accepts one vote
        per member per poll.
      </PageTitle>
      {!SIGNAL ? (
        <NotLiveYet />
      ) : link === undefined ? null : link.kind === "broken" ? (
        <p className="glass-strong p-5 text-sm text-error" data-testid="zk-broken-link">
          This poll link cannot be read: {link.reason}. Ask the group&apos;s admin for the link
          again.
        </p>
      ) : (
        <RequireWallet>
          {link.kind === "poll" ? (
            <Poll poll={link.poll} demo={false} />
          ) : IS_LOCAL && link.kind === "none" ? (
            <Poll poll={DEMO} demo />
          ) : (
            <Tools />
          )}
        </RequireWallet>
      )}
    </>
  );
}

/** A group's members from MembersAdded events, in order, the root they must produce, and the
 * signals sent in the group. */
function useGroup(group: bigint | undefined) {
  const client = usePublicClient();
  return useQuery({
    queryKey: ["arl-group", client?.chain.id, group?.toString()],
    enabled: !!client && !!SIGNAL && group !== undefined,
    refetchInterval: REFRESH_MS,
    queryFn: async () => {
      if (!client || !SIGNAL || group === undefined) throw new Error("no client");
      const exists =
        (await client.readContract({
          address: SIGNAL.address,
          abi: ABI,
          functionName: "groupCount",
        })) > group;
      if (!exists) return { exists: false as const };
      const [events, root, admin, votes] = await Promise.all([
        eventsSince(client, deployBlock(SIGNAL), (range) =>
          client.getContractEvents({
            address: SIGNAL.address,
            abi: ABI,
            eventName: "MembersAdded",
            args: { groupId: group },
            ...range,
          }),
        ),
        client.readContract({
          address: SIGNAL.address,
          abi: ABI,
          functionName: "groupRoot",
          args: [group],
        }),
        client.readContract({
          address: SIGNAL.address,
          abi: ABI,
          functionName: "groupAdmin",
          args: [group],
        }),
        eventsSince(client, deployBlock(SIGNAL), (range) =>
          client.getContractEvents({
            address: SIGNAL.address,
            abi: ABI,
            eventName: "Signal",
            args: { groupId: group },
            ...range,
          }),
        ),
      ]);
      const members = events.flatMap((e) => [...(e.args.commitments ?? [])]);
      const tree = createGroup(members);
      return {
        exists: true as const,
        members,
        tree,
        root,
        admin,
        // The published list must rebuild exactly the root the contract holds.
        consistent: members.length > 0 && tree.root === root,
        signals: votes.map((v) => ({ scope: v.args.scope ?? 0n, message: v.args.message ?? 0n })),
      };
    },
  });
}

/** The identity of the connected wallet for this chain: a secret kept only in this page. */
function useIdentity(onError: (text: string) => void) {
  const { targetNetwork } = useTargetNetwork();
  const { signMessageAsync } = useSignMessage();
  const [secret, setSecret] = useState<bigint>();
  const create = async () => {
    try {
      const signature = await signMessageAsync({
        message: identityMessage(`eip155:${String(targetNetwork.id)}`),
      });
      setSecret(secretFromSignature(signature));
    } catch {
      onError("The signature was not given.");
    }
  };
  return { secret, mine: secret !== undefined ? commitment(secret) : undefined, create };
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === "idle") return null;
  return (
    <p
      className={`glass-chip px-4 py-3 text-sm ${status.kind === "error" ? "text-error" : ""}`}
      role="status"
      data-testid="zk-status"
    >
      {status.kind === "busy" ? <span className="loading loading-spinner loading-xs mr-2" /> : null}
      {status.text}
    </p>
  );
}

function Poll({ poll, demo }: { poll: PrivatePoll; demo: boolean }) {
  const { targetNetwork } = useTargetNetwork();
  const client = usePublicClient();
  const { writeContractAsync } = useWriteContract();
  const { data: g, refetch } = useGroup(poll.group);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const { secret, mine, create } = useIdentity((text) => {
    setStatus({ kind: "error", text });
  });
  const [copied, setCopied] = useState(false);

  const scope = pollScope(poll.group, poll.poll);
  const group = g?.exists ? g : undefined;
  const member = mine !== undefined && !!group?.members.includes(mine);
  const busy = status.kind === "busy";
  const counts = tallyPoll(group?.signals ?? [], scope, poll.options.length);

  // Local demo roles: Anvil development accounts that the local node unlocks (no keys).
  const localWallet = (account: `0x${string}`) =>
    createWalletClient({
      account,
      chain: targetNetwork,
      transport: http(targetNetwork.rpcUrls.default.http[0]),
    });

  const join = async () => {
    if (mine === undefined || !group || !client || !SIGNAL) return;
    setStatus({ kind: "busy", text: "Adding you to the group" });
    try {
      const next = createGroup([...group.members, mine]);
      const hash = await localWallet(DEMO_GROUP_ADMIN).writeContract({
        address: SIGNAL.address,
        abi: ABI,
        functionName: "addMembers",
        args: [poll.group, [mine], next.root],
      });
      await client.waitForTransactionReceipt({ hash });
      await refetch();
      setStatus({
        kind: "done",
        text: "You are a member. Only your public commitment was published.",
      });
    } catch (e) {
      setStatus({ kind: "error", text: firstLine(e, "Could not join") });
    }
  };

  const vote = async (option: number) => {
    if (secret === undefined || !group || !client || !SIGNAL) return;
    if (!group.consistent)
      return setStatus({
        kind: "error",
        text: "The published member list does not match the root.",
      });
    try {
      setStatus({ kind: "busy", text: "Proving membership in your browser" });
      const inputs = signalInputs(secret, group.tree, scope, optionMessage(option));
      const used = await client.readContract({
        address: SIGNAL.address,
        abi: ABI,
        functionName: "isNullifierUsed",
        args: [poll.group, inputs.nullifier],
      });
      if (used) return setStatus({ kind: "error", text: "You have already voted in this poll." });
      const proof = await proveSignal(circuit, inputs);
      const call = {
        address: SIGNAL.address,
        abi: ABI,
        functionName: "signal",
        args: [poll.group, proof.scope, proof.message, proof.root, proof.nullifier, proof.proof],
      } as const;
      let hash: `0x${string}`;
      if (demo) {
        setStatus({ kind: "busy", text: "Submitting through the relayer" });
        hash = await localWallet(DEMO_RELAYER).writeContract(call);
      } else {
        setStatus({ kind: "busy", text: "Confirm the transaction in your wallet" });
        hash = await writeContractAsync(call);
      }
      await client.waitForTransactionReceipt({ hash });
      await refetch();
      setStatus({
        kind: "done",
        text: demo
          ? "Your vote was counted. Nothing on-chain links it to your wallet."
          : "Your vote was counted. The proof does not say which member voted.",
      });
    } catch (e) {
      setStatus({ kind: "error", text: firstLine(e, "Voting failed") });
    }
  };

  if (g && !g.exists) {
    return (
      <p className="glass-strong p-5 text-sm text-error" data-testid="zk-no-group">
        Group {poll.group.toString()} does not exist on this chain. Ask the group&apos;s admin for
        the link again.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-strong flex flex-col gap-3 p-5" aria-labelledby="identity-heading">
        <h2 id="identity-heading" className="text-sm font-extrabold">
          1 · Your private identity
        </h2>
        <p className="text-sm text-muted">
          Your wallet signs a fixed message; the identity secret is derived from that signature in
          this page and is never stored or sent. Signing again later gives the same identity. Only
          its public commitment is ever shared.
        </p>
        {secret === undefined ? (
          <button
            type="button"
            className="btn btn-primary self-start"
            onClick={() => void create()}
            data-testid="zk-identity"
          >
            Create my identity
          </button>
        ) : (
          <Facts inset>
            <Stat
              label="Public commitment"
              value={<span className="font-mono text-xs">{mine?.toString().slice(0, 18)}…</span>}
              testId="zk-commitment"
            />
            <Stat
              label="Group membership"
              value={member ? "Member" : "Not a member yet"}
              testId="zk-member"
            />
          </Facts>
        )}
        {secret !== undefined && !member && demo ? (
          <button
            type="button"
            className="btn btn-glass self-start"
            disabled={busy || !group}
            onClick={() => void join()}
            data-testid="zk-join"
          >
            Join the demo group
          </button>
        ) : null}
        {mine !== undefined && !member && !demo ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted">
              You are not in this group yet. Send your public commitment to the group&apos;s admin;
              it is safe to share and says nothing about your wallet.
            </p>
            <code className="break-all rounded bg-base-200 p-2 text-xs" data-testid="zk-mine">
              {mine.toString()}
            </code>
            <button
              type="button"
              className="btn btn-glass btn-sm self-start"
              onClick={() => {
                void navigator.clipboard.writeText(mine.toString()).then(() => {
                  setCopied(true);
                });
              }}
            >
              {copied ? "Copied" : "Copy my commitment"}
            </button>
          </div>
        ) : null}
      </section>

      <section className="glass-strong flex flex-col gap-3 p-5" aria-labelledby="poll-heading">
        <h2 id="poll-heading" className="text-sm font-extrabold" data-testid="zk-question">
          2 · {poll.question}
        </h2>
        {demo ? (
          <p className="text-sm text-muted">
            One vote per member. The vote is sent by a relayer, so the sender is not your wallet
            either.
          </p>
        ) : (
          <p className="text-sm text-muted" data-testid="zk-sender-note">
            One vote per member. The question and the options are written in the link you opened;
            the contract records poll {poll.poll.toString()} of group {poll.group.toString()} and
            the number of the option. The proof never says which member voted, but the wallet that
            sends the transaction is public: to keep that apart too, switch your wallet to an
            account that is not linked to you after creating your identity, and vote from there.
          </p>
        )}
        <ul
          className="divide-y divide-white/8 rounded-xl border border-white/10"
          data-testid="zk-results"
        >
          {poll.options.map((label, i) => (
            <li key={label} className="flex items-center justify-between gap-3 px-4 py-3">
              <span className="text-sm">{label}</span>
              <span className="flex items-center gap-3">
                <span className="stat-value-arl text-sm" data-testid={`zk-count-${String(i)}`}>
                  {counts[i] ?? 0}
                </span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={!member || busy}
                  onClick={() => void vote(i)}
                  data-testid={`zk-vote-${String(i)}`}
                >
                  Vote
                </button>
              </span>
            </li>
          ))}
        </ul>
        <Facts inset>
          <Stat label="Members" value={group ? group.members.length : "…"} testId="zk-members" />
          <Stat
            label="Member list"
            value={
              <span className="text-sm font-normal">
                {group
                  ? group.consistent
                    ? "matches the on-chain root"
                    : "does not match the root"
                  : "…"}
              </span>
            }
          />
        </Facts>
      </section>

      <StatusLine status={status} />
    </div>
  );
}

const field = "textarea textarea-bordered w-full font-mono text-xs";
const input = "input input-bordered w-full";

/** For a group's admin: start a group, add members and make the link of a poll. */
function Tools() {
  const client = usePublicClient();
  const { address } = useAccount();
  const { writeContractAsync } = useWriteContract();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const busy = status.kind === "busy";
  const { mine, create } = useIdentity((text) => {
    setStatus({ kind: "error", text });
  });

  const [first, setFirst] = useState("");
  const [created, setCreated] = useState<bigint>();
  const [groupText, setGroupText] = useState("");
  const [more, setMore] = useState("");
  const [pollText, setPollText] = useState("1");
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState("");

  const groupId = /^\d{1,39}$/.test(groupText.trim()) ? BigInt(groupText.trim()) : undefined;
  const { data: g, refetch } = useGroup(groupId);
  const group = g?.exists ? g : undefined;
  const isAdmin = !!group && !!address && group.admin.toLowerCase() === address.toLowerCase();

  const startGroup = async () => {
    if (!client || !SIGNAL) return;
    try {
      const members = parseCommitments(first);
      const root = createGroup(members).root;
      setStatus({ kind: "busy", text: "Confirm the transaction in your wallet" });
      const hash = await writeContractAsync({
        address: SIGNAL.address,
        abi: ABI,
        functionName: "createGroupWithMembers",
        args: [members, root],
      });
      const receipt = await client.waitForTransactionReceipt({ hash });
      const [event] = parseEventLogs({ abi: ABI, eventName: "GroupCreated", logs: receipt.logs });
      if (!event) throw new Error("the group was not created");
      setCreated(event.args.groupId);
      setGroupText(event.args.groupId.toString());
      setFirst("");
      setStatus({
        kind: "done",
        text: `Group ${event.args.groupId.toString()} was created with ${String(members.length)} member(s). You are its admin.`,
      });
    } catch (e) {
      setStatus({ kind: "error", text: firstLine(e, "Could not create the group") });
    }
  };

  const addMembers = async () => {
    if (!client || !SIGNAL || !group || groupId === undefined) return;
    try {
      if (!group.consistent)
        throw new PollError("the published member list does not match the root");
      const added = parseCommitments(more, group.members);
      const root = createGroup([...group.members, ...added]).root;
      setStatus({ kind: "busy", text: "Confirm the transaction in your wallet" });
      const hash = await writeContractAsync({
        address: SIGNAL.address,
        abi: ABI,
        functionName: "addMembers",
        args: [groupId, added, root],
      });
      await client.waitForTransactionReceipt({ hash });
      await refetch();
      setMore("");
      setStatus({ kind: "done", text: `${String(added.length)} member(s) were added.` });
    } catch (e) {
      setStatus({ kind: "error", text: firstLine(e, "Could not add the members") });
    }
  };

  let link: string | undefined;
  let linkProblem: string | undefined;
  if (groupId !== undefined && question.trim() !== "") {
    try {
      const query = pollQuery({
        group: groupId,
        poll: /^\d{1,39}$/.test(pollText.trim()) ? BigInt(pollText.trim()) : -1n,
        question,
        options: options.split("\n").filter((o) => o.trim() !== ""),
      });
      link = `${window.location.origin}${window.location.pathname}?${query}`;
    } catch (e) {
      linkProblem = e instanceof PollError ? e.message : "the poll cannot be read";
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="glass-strong flex flex-col gap-3 p-5" aria-labelledby="how-heading">
        <h2 id="how-heading" className="text-sm font-extrabold">
          How a private poll works
        </h2>
        <p className="text-sm text-muted">
          Each member creates a private identity here and sends its public commitment to the
          group&apos;s admin. The admin publishes the commitments as a group and shares the link of
          a poll. A member opens the link and votes with a proof made in the browser. To vote in a
          poll, open the link its admin gave you.
        </p>
        {mine === undefined ? (
          <button
            type="button"
            className="btn btn-primary self-start"
            onClick={() => void create()}
            data-testid="zk-identity"
          >
            Create my identity
          </button>
        ) : (
          <>
            <p className="text-sm text-muted">Your public commitment, to send to an admin:</p>
            <code className="break-all rounded bg-base-200 p-2 text-xs" data-testid="zk-mine">
              {mine.toString()}
            </code>
          </>
        )}
      </section>

      <section className="glass-strong flex flex-col gap-3 p-5" aria-labelledby="group-heading">
        <h2 id="group-heading" className="text-sm font-extrabold">
          Start a group
        </h2>
        <p className="text-sm text-muted">
          Paste the commitments of the first members, one per line. Your wallet becomes the
          group&apos;s admin: it can add members later, and it cannot vote for them or see who
          voted.
        </p>
        <textarea
          className={field}
          rows={4}
          value={first}
          onChange={(e) => {
            setFirst(e.target.value);
          }}
          placeholder="One commitment per line"
          data-testid="zk-first-members"
        />
        <button
          type="button"
          className="btn btn-primary self-start"
          disabled={busy || first.trim() === ""}
          onClick={() => void startGroup()}
          data-testid="zk-create-group"
        >
          Create the group
        </button>
        {created !== undefined ? (
          <p className="text-sm" data-testid="zk-created-group">
            Your group number is {created.toString()}.
          </p>
        ) : null}
      </section>

      <section className="glass-strong flex flex-col gap-3 p-5" aria-labelledby="manage-heading">
        <h2 id="manage-heading" className="text-sm font-extrabold">
          Your group and its polls
        </h2>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Group number
          <input
            className={input}
            inputMode="numeric"
            value={groupText}
            onChange={(e) => {
              setGroupText(e.target.value);
            }}
            data-testid="zk-group-number"
          />
        </label>
        {groupId !== undefined && g ? (
          g.exists ? (
            <Facts inset>
              <Stat label="Members" value={g.members.length} testId="zk-members" />
              <Stat
                label="Admin"
                value={
                  <span className="text-sm font-normal">
                    {isAdmin
                      ? "the connected wallet"
                      : `${g.admin.slice(0, 6)}…${g.admin.slice(-4)}`}
                  </span>
                }
              />
            </Facts>
          ) : (
            <p className="text-sm text-error">This group does not exist.</p>
          )
        ) : null}

        {isAdmin ? (
          <>
            <label className="flex flex-col gap-1 text-sm text-muted">
              Add members (one commitment per line)
              <textarea
                className={field}
                rows={3}
                value={more}
                onChange={(e) => {
                  setMore(e.target.value);
                }}
                data-testid="zk-more-members"
              />
            </label>
            <button
              type="button"
              className="btn btn-glass self-start"
              disabled={busy || more.trim() === ""}
              onClick={() => void addMembers()}
              data-testid="zk-add-members"
            >
              Add the members
            </button>
          </>
        ) : null}

        <label className="flex flex-col gap-1 text-sm text-muted">
          Poll number (a new number for every poll of the group)
          <input
            className={input}
            inputMode="numeric"
            value={pollText}
            onChange={(e) => {
              setPollText(e.target.value);
            }}
            data-testid="zk-poll-number"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Question
          <input
            className={input}
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
            }}
            data-testid="zk-poll-question"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          Options (one per line, two to eight)
          <textarea
            className="textarea textarea-bordered w-full text-sm"
            rows={3}
            value={options}
            onChange={(e) => {
              setOptions(e.target.value);
            }}
            data-testid="zk-poll-options"
          />
        </label>
        {link ? (
          <>
            <p className="text-sm text-muted">
              The poll link. Share it with the members; nothing is sent to the chain to make it.
            </p>
            <code className="break-all rounded bg-base-200 p-2 text-xs" data-testid="zk-poll-link">
              {link}
            </code>
            <a className="btn btn-glass btn-sm self-start" href={link}>
              Open the poll
            </a>
          </>
        ) : linkProblem ? (
          <p className="text-sm text-error" data-testid="zk-poll-problem">
            {linkProblem}
          </p>
        ) : null}
      </section>

      <StatusLine status={status} />
    </div>
  );
}
