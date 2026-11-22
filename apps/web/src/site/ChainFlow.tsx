import Link from "next/link";

// How one verified job moves through Base, in five steps: the flow that is live on Base Mainnet
// (job 1 ran it and was paid on 2026-11-21). A light travels the steps and a row of Base blocks
// slides past. Everything moves on one clock (`--flow-cycle` in globals.css): each step lights up
// as the light reaches it, and the block under the last step lights up as the light arrives
// there. All of it stops when the visitor prefers reduced motion. Horizontal on wide screens,
// vertical on phones.

type IconName = "wallet" | "vault" | "chip" | "check" | "record";

const STEPS: readonly { title: string; body: string; tech: string; icon: IconName }[] = [
  {
    title: "Client",
    body: "Opens a job and funds it",
    tech: "ARL or USDC · ERC-8183",
    icon: "wallet",
  },
  { title: "Escrow", body: "Holds the payment", tech: "on Base · no fee", icon: "vault" },
  { title: "Agent", body: "Does the work and submits it", tech: "ERC-8004 identity", icon: "chip" },
  {
    title: "Validators",
    body: "Re-run the work and vote",
    tech: "staked ARL · challenge window",
    icon: "check",
  },
  {
    title: "Paid, on record",
    body: "Escrow pays; outcome saved",
    tech: "public, permanent",
    icon: "record",
  },
];

/** Seconds the light takes from the first step to the last; the same value as `--flow-cycle`. */
const CYCLE = 4.5;
/**
 * When the light reaches step `i`, as a negative delay: every step is already on the shared
 * clock when the page loads, and pulses exactly as the light arrives.
 */
const arrival = (i: number) => `${((i * CYCLE) / (STEPS.length - 1) - CYCLE).toFixed(3)}s`;

/** Line icons drawn around (0, 0), about 30 units across. */
function Icon({ name }: { name: IconName }) {
  switch (name) {
    case "wallet":
      return (
        <>
          <rect x="-15" y="-11" width="30" height="22" rx="5" />
          <path d="M15 -3h-8a3 3 0 0 0 0 6h8" />
        </>
      );
    case "chip":
      return (
        <>
          <rect x="-11" y="-11" width="22" height="22" rx="4" />
          <rect x="-5" y="-5" width="10" height="10" rx="1.5" />
          <path d="M-6 -15v4M0 -15v4M6 -15v4M-6 11v4M0 11v4M6 11v4M-15 -6h4M-15 0h4M-15 6h4M11 -6h4M11 0h4M11 6h4" />
        </>
      );
    case "check":
      return (
        <>
          <circle r="14" />
          <path d="M-6 0l4 4 8-9" />
        </>
      );
    case "vault":
      return (
        <>
          <path d="M0 -15l13 7.5v15L0 15l-13-7.5v-15z" />
          <path d="M-13 -7.5L0 0l13-7.5M0 0v15" />
        </>
      );
    default:
      return (
        <>
          <circle cx="-3" cy="-3" r="10" />
          <path d="M4.5 4.5L13 13" />
        </>
      );
  }
}

const icon = {
  fill: "none",
  stroke: "#efd9ab",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/** The light. It follows `path` with CSS, on the same clock as the steps and the blocks. */
function Packet({ path }: { path: string }) {
  return (
    <g className="flow-packet" style={{ offsetPath: `path("${path}")` }}>
      <circle r="13" fill="url(#arl-flow-packet)" />
      <circle r="4" fill="#fff" />
    </g>
  );
}

const BLOCK = 116;
/** Blocks before the first visible one and up to the right edge. */
const BLOCKS = Array.from({ length: 11 }, (_, i) => i - 1);

function Wide() {
  const y = 112;
  const xs = STEPS.map((_, i) => 104 + i * 208);
  const last = xs[xs.length - 1] ?? 936;
  // The block that sits under the last step when a cycle starts: where the payment lands.
  const paid = 7;
  const first = last - 50 - paid * BLOCK;
  const rail = `M${xs[0]} ${y} H${last}`;
  return (
    <svg className="flow flow-wide" viewBox="0 0 1040 396" aria-hidden="true" focusable="false">
      <path
        d={rail}
        stroke="url(#arl-flow-line)"
        strokeWidth="2"
        fill="none"
        strokeDasharray="4 8"
        className="flow-dash"
      />
      {STEPS.map((s, i) => (
        <g
          key={s.title}
          transform={`translate(${xs[i]} ${y})`}
          style={{ "--d": arrival(i) } as React.CSSProperties}
        >
          <circle r="44" className="flow-halo" />
          <circle r="36" className="flow-disc" />
          <g {...icon}>
            <Icon name={s.icon} />
          </g>
          <text y="-58" className="flow-num">{`0${i + 1}`}</text>
          <text y="72" className="flow-t1">
            {s.title}
          </text>
          <text y="94" className="flow-t2">
            {s.body}
          </text>
          <text y="114" className="flow-t3">
            {s.tech}
          </text>
        </g>
      ))}
      <Packet path={rail} />
      <text x="520" y="278" className="flow-cap">
        Base blocks, about five every second
      </text>
      <path d={`M${last} ${y + 128} V306`} className="flow-drop" />
      <defs>
        <linearGradient id="arl-flow-fade-g" x1="0" x2="1040" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".08" stopColor="#fff" />
          <stop offset=".96" stopColor="#fff" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <mask id="arl-flow-fade" maskUnits="userSpaceOnUse" x="0" y="0" width="1040" height="396">
          <rect width="1040" height="396" fill="url(#arl-flow-fade-g)" />
        </mask>
      </defs>
      <g mask="url(#arl-flow-fade)">
        <g className="flow-chain">
          {BLOCKS.map((i) => (
            <g
              key={i}
              transform={`translate(${first + i * BLOCK} 0)`}
              className={i === paid ? "on" : ""}
            >
              <rect width="100" height="64" rx="10" />
              <text x="12" y="26" className="flow-bn">
                Block
              </text>
              <text x="12" y="46" className="flow-bt">
                {i === paid ? "job paid" : "txs"}
              </text>
              <path d="M100 32h16" className="flow-link" />
            </g>
          ))}
        </g>
      </g>
    </svg>
  );
}

function Narrow() {
  const x = 56;
  const ys = STEPS.map((_, i) => 60 + i * 132);
  const rail = `M${x} ${ys[0]} V${ys[ys.length - 1]}`;
  return (
    <svg className="flow flow-narrow" viewBox="0 0 358 650" aria-hidden="true" focusable="false">
      <path
        d={rail}
        stroke="#d9b77a"
        strokeOpacity="0.45"
        strokeWidth="2"
        fill="none"
        strokeDasharray="4 8"
        className="flow-dash"
      />
      {STEPS.map((s, i) => (
        <g
          key={s.title}
          transform={`translate(${x} ${ys[i]})`}
          style={{ "--d": arrival(i) } as React.CSSProperties}
        >
          <circle r="34" className="flow-halo" />
          <circle r="28" className="flow-disc" />
          <g {...icon} strokeWidth={2.4} transform="scale(.8)">
            <Icon name={s.icon} />
          </g>
          <text x="52" y="-14" className="flow-num start">{`0${i + 1}`}</text>
          <text x="52" y="8" className="flow-t1 start">
            {s.title}
          </text>
          <text x="52" y="30" className="flow-t2 start">
            {s.body}
          </text>
          <text x="52" y="50" className="flow-t3 start">
            {s.tech}
          </text>
        </g>
      ))}
      <Packet path={rail} />
    </svg>
  );
}

export function ChainFlow() {
  return (
    <figure className="m-0">
      <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="arl-flow-line" x1="0" x2="1">
            <stop offset="0" stopColor="#d9b77a" stopOpacity=".15" />
            <stop offset=".5" stopColor="#d9b77a" stopOpacity=".6" />
            <stop offset="1" stopColor="#d9b77a" stopOpacity=".15" />
          </linearGradient>
          <radialGradient id="arl-flow-packet">
            <stop offset="0" stopColor="#fff" />
            <stop offset=".45" stopColor="#bfe9ff" />
            <stop offset="1" stopColor="#d9b77a" stopOpacity="0" />
          </radialGradient>
        </defs>
      </svg>
      <Wide />
      <Narrow />
      <figcaption>
        <ol className="sr-only">
          {STEPS.map((s) => (
            <li key={s.title}>
              {s.title}: {s.body} ({s.tech}).
            </li>
          ))}
        </ol>
        <span className="mt-3 block text-[13px] text-fg-subtle">
          Live on Base Mainnet: the first job ran these five steps and was paid.{" "}
          <Link href="/demo" prefetch={false} className="text-accent underline underline-offset-4">
            Step through a job
          </Link>
        </span>
      </figcaption>
    </figure>
  );
}
