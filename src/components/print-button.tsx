"use client";

/** Opens the browser's print dialog, which also offers "Save as PDF". */
export function PrintButton() {
  return (
    <button type="button" className="btn" onClick={() => window.print()}>
      Print
    </button>
  );
}
