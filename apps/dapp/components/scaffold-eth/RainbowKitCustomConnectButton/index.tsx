"use client";

// Adapted from Scaffold-ETH 2 (MIT, BuidlGuidl):
// packages/nextjs/components/scaffold-eth/RainbowKitCustomConnectButton/index.tsx.
// ARL: no burner-wallet key reveal, no QR modal, no block explorer on the local chain; shows the
// chain name instead of the native balance. On a phone browser with no wallet inside it, the
// button first offers to open ARL in a wallet app (components/arl/OpenInWallet.tsx).
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useState } from "react";
import type { Address } from "viem";

import { AddressInfoDropdown } from "./AddressInfoDropdown";
import { WrongNetworkDropdown } from "./WrongNetworkDropdown";
import { OpenInWalletDialog, needsWalletApp } from "~~/components/arl/OpenInWallet";
import { useNetworkColor } from "~~/hooks/scaffold-eth";
import { useTargetNetwork } from "~~/hooks/scaffold-eth/useTargetNetwork";

export const RainbowKitCustomConnectButton = () => {
  const networkColor = useNetworkColor();
  const { targetNetwork } = useTargetNetwork();
  // On a phone browser with no wallet inside it, offer to open ARL in the wallet app first.
  const [choosing, setChoosing] = useState(false);

  return (
    <ConnectButton.Custom>
      {({ account, chain, openConnectModal, mounted }) => {
        const connected = mounted && account && chain;
        if (!connected) {
          return (
            <>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  if (needsWalletApp()) setChoosing(true);
                  else openConnectModal();
                }}
                type="button"
              >
                Connect wallet
              </button>
              {choosing && (
                <OpenInWalletDialog
                  onClose={() => {
                    setChoosing(false);
                  }}
                  onOtherWallets={openConnectModal}
                />
              )}
            </>
          );
        }
        if (chain.unsupported || chain.id !== targetNetwork.id) return <WrongNetworkDropdown />;
        return (
          <div className="flex items-center gap-2">
            <span className="hidden text-xs sm:inline" style={{ color: networkColor }}>
              {chain.name}
            </span>
            <AddressInfoDropdown address={account.address as Address} />
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
};
