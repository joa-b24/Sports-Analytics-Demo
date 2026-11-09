// The phone / tablet build of the app (a PWA, built with NEXT_PUBLIC_MOBILE=1; scripts/build_mobile.mjs). It has no server
// on the laptop: the files of a match folder live in the browser (lib/mobileFs.ts) and nothing is processed on the device.
// Detection, tracking and the other long jobs are run on the laptop, a dedicated PC or Kaggle.

export const MOBILE = process.env.NEXT_PUBLIC_MOBILE === "1";

// NEXT_PUBLIC_MOBILE_FULL=1 also shows the steps that edit tracking (calibration, tracking, ball): they work on the files
// of the zip, but only to look at and correct; every button that would run something stays off.
export const MOBILE_FULL = MOBILE && process.env.NEXT_PUBLIC_MOBILE_FULL === "1";

// Steps of the match that the mobile build hides by default.
export const MOBILE_HIDDEN_STEPS: readonly string[] = ["calibration", "segments", "tracking", "ball"];
export const stepVisible = (step: string) => !MOBILE || MOBILE_FULL || !MOBILE_HIDDEN_STEPS.includes(step);

export const NO_RUN_MESSAGE = "En el celular o la tablet no se procesa nada: usa la laptop, un PC dedicado o Kaggle.";

// Everything that would run a job answers at once with a message instead of waiting for a server that is not there.
export function installMobileGuards() {
  if (!MOBILE || typeof window === "undefined") return;
  const w = window as unknown as { __sportsanGuards?: boolean };
  if (w.__sportsanGuards) return;
  w.__sportsanGuards = true;
  const real = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (/\/api\/(run|rename)(\/|\?|$)/.test(url)) return Promise.resolve(new Response(JSON.stringify({ error: NO_RUN_MESSAGE }), { status: 501, headers: { "content-type": "application/json" } }));
    return real(input, init);
  };
}
