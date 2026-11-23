"use client";

// On a phone, a normal browser (Safari, Chrome) has no wallet inside it, and wallets other than
// Coinbase Wallet can only be reached from it through WalletConnect. The reliable way in is to
// open the app inside the wallet's own browser, where the wallet is injected and connects with
// one tap. Each link below is the wallet's published deep link; nothing is sent anywhere else.

import { createPortal } from "react-dom";

/** A phone or tablet browser with no wallet injected into the page (read at click time). */
export function needsWalletApp(): boolean {
  const w = window as Window & { ethereum?: unknown };
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) && !w.ethereum;
}

function walletLinks(url: string) {
  const bare = url.replace(/^https?:\/\//, "");
  const enc = encodeURIComponent(url);
  return [
    { name: "MetaMask", href: `https://metamask.app.link/dapp/${bare}` },
    { name: "Coinbase Wallet", href: `https://go.cb-w.com/dapp?cb_url=${enc}` },
    { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=60&url=${enc}` },
    {
      name: "OKX Wallet",
      href: `https://www.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${enc}`)}`,
    },
    {
      name: "Phantom",
      href: `https://phantom.app/ul/browse/${enc}?ref=${encodeURIComponent(new URL(url).origin)}`,
    },
  ];
}

/** The choice shown on a phone: open ARL in a wallet app, or use the usual list. */
export function OpenInWalletDialog({
  onClose,
  onOtherWallets,
}: {
  onClose: () => void;
  onOtherWallets: () => void;
}) {
  const links = walletLinks(window.location.href);
  // Rendered on <body>: the header's backdrop filter would otherwise clip a fixed overlay.
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="open-in-wallet-title"
      onClick={onClose}
    >
      <div
        className="glass-strong w-full max-w-sm p-5"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <h2 id="open-in-wallet-title" className="text-lg font-semibold">
          Open ARL in your wallet
        </h2>
        <p className="mt-1 text-sm text-muted">
          Your wallet app opens this page in its own browser and connects with one tap.
        </p>
        <ul className="mt-4 flex flex-col gap-2">
          {links.map((l) => (
            <li key={l.name}>
              <a href={l.href} className="btn btn-glass w-full justify-start" rel="noopener">
                {l.name}
              </a>
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn btn-ghost btn-sm mt-3 w-full text-muted"
          onClick={() => {
            onClose();
            onOtherWallets();
          }}
        >
          Other wallets
        </button>
      </div>
    </div>,
    document.body,
  );
}
