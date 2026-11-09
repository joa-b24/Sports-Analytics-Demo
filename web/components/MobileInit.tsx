"use client";

import { useEffect } from "react";
import { MOBILE, installMobileGuards } from "@/lib/mobile";

// Mobile build only: answers the calls that would run a job and registers the service worker (offline use, installable).
export function MobileInit() {
  useEffect(() => {
    if (!MOBILE) return;
    installMobileGuards();
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch(() => {});
    void navigator.storage?.persist?.().catch(() => {});
  }, []);
  return null;
}
