// wagmi's useWriteContract with the app's Builder Code suffix on every write sent on Base Mainnet.
// wagmi does not apply a dataSuffix set in createConfig to a connected wallet's writes, so it is
// passed on each call. A caller's own dataSuffix wins.
"use client";

import { useChainId, useWriteContract as useWagmiWriteContract } from "wagmi";

import { builderSuffix } from "~~/lib/builderCode";

export const useWriteContract = ((parameters?: Parameters<typeof useWagmiWriteContract>[0]) => {
  const chainId = useChainId();
  const result = useWagmiWriteContract(parameters);
  const withSuffix = <V extends { chainId?: number; dataSuffix?: unknown }>(variables: V): V => {
    const dataSuffix = builderSuffix(variables.chainId ?? chainId);
    return dataSuffix ? { dataSuffix, ...variables } : variables;
  };
  return {
    ...result,
    writeContract: (variables: never, options?: never) =>
      result.writeContract(withSuffix(variables as { chainId?: number }) as never, options),
    writeContractAsync: (variables: never, options?: never) =>
      result.writeContractAsync(withSuffix(variables as { chainId?: number }) as never, options),
  };
}) as typeof useWagmiWriteContract;
