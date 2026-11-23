"use client";

import { useEffect } from "react";

// Mounted once in the root layout. The neon frames and dots (globals.css) share one beat, but a
// CSS animation starts when its element appears, so cards that render at different moments would
// pulse out of step. This pins every one of them to the document timeline's origin: same beat,
// same start, so they all light up and dim together, including cards added later.

const NEON = new Set(["road-frame", "road-blink", "done-frame", "tint-neon"]);

function sync(): void {
  for (const a of document.getAnimations()) {
    if (a instanceof CSSAnimation && NEON.has(a.animationName) && a.startTime !== 0) {
      a.startTime = 0;
    }
  }
}

export function NeonSync() {
  useEffect(() => {
    if (typeof document.getAnimations !== "function") return;
    sync();
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        sync();
      });
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-progress", "data-status"],
    });
    return () => observer.disconnect();
  }, []);
  return null;
}
