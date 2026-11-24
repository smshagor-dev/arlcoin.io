// ERC-8021 attribution: the app's Base Builder Code, appended to the calldata of the writes it
// sends on Base Mainnet. Contracts decode their arguments and ignore the trailing bytes.
// The suffix is `Attribution.toDataSuffix({ codes: [BUILDER_CODE] })` from ox/erc8021, spelled out
// so that the app does not depend on ox directly; a unit test rebuilds it.
import type { Hex } from "viem";

export const BUILDER_CODE = "bc_3h7lu5h0";
export const BUILDER_SUFFIX: Hex = "0x62635f3368376c753568300b0080218021802180218021802180218021";

/** The suffix on Base Mainnet, nothing on any other network. */
export const builderSuffix = (chainId: number | undefined): Hex | undefined =>
  chainId === 8453 ? BUILDER_SUFFIX : undefined;
