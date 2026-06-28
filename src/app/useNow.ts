import { useEffect, useState } from "react";

/** Returns the current epoch-ms, re-rendering every `ms` WHILE `active`. Lets a
 * live elapsed/throughput readout advance smoothly even when the backend's scan
 * events are bursty (the walker threads can starve the emit ticker, so leaning on
 * events alone makes the clock visibly freeze). Idle when inactive — no timer. */
export function useNow(active: boolean, ms = 250): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now()); // fresh baseline the moment we go active
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [active, ms]);
  return now;
}
