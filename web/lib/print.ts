// Printing on the app's colours or on white paper (globals.css reads `data-paper` on <html> inside @media print).

export type Paper = "app" | "white";

export function setPaper(paper: Paper | null): void {
  const root = document.documentElement;
  if (paper === "white") root.dataset.paper = "white";
  else delete root.dataset.paper;
}

// Prints once with that paper and goes back to the app's colours afterwards.
export function printWith(paper: Paper): void {
  const before = document.documentElement.dataset.paper ?? null;
  setPaper(paper);
  const restore = () => {
    setPaper(before === "white" ? "white" : null);
    window.removeEventListener("afterprint", restore);
  };
  window.addEventListener("afterprint", restore);
  window.print();
}
