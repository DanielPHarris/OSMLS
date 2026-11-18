"use client";

import type { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { MapConfig } from "@/lib/map-config";

export type MapStatus = "loading" | "ready" | "unavailable";
export type MapLibre = typeof import("maplibre-gl");

/**
 * Creates a map in the given container. If the map source cannot be loaded, the
 * status becomes "unavailable" and the rest of the page carries on without it.
 */
export function useMap(
  config: MapConfig,
  initial: { longitude: number; latitude: number; zoom: number },
) {
  const container = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<MapStatus>("loading");
  const [ready, setReady] = useState<{ map: MapLibreMap; lib: MapLibre } | null>(null);
  const initialRef = useRef(initial);

  useEffect(() => {
    let cancelled = false;
    let map: MapLibreMap | undefined;
    let giveUp: ReturnType<typeof setTimeout> | undefined;

    (async () => {
      try {
        const lib = await import("maplibre-gl");
        if (cancelled || !container.current) return;
        // Served by this application; see src/app/maplibre-gl-worker.mjs/route.ts.
        lib.setWorkerUrl("/maplibre-gl-worker.mjs");
        const view = initialRef.current;
        map = new lib.Map({
          container: container.current,
          style: config.styleUrl,
          center: [view.longitude, view.latitude],
          zoom: view.zoom,
          // Added below, uncollapsed, so map credits are always on show.
          attributionControl: false,
        });
        map.addControl(new lib.AttributionControl({ compact: false }), "bottom-right");
        map.addControl(new lib.NavigationControl({ showCompass: false }), "top-right");

        let loaded = false;
        const fail = () => {
          if (loaded || cancelled) return;
          setStatus("unavailable");
          setReady(null);
        };
        // Errors after loading (a missing tile, say) do not take the map away.
        map.on("error", fail);
        giveUp = setTimeout(fail, 15_000);
        // Keep the map, its pins, and its credits in step when the window changes size.
        const fit = () => map?.resize();
        window.addEventListener("resize", fit);
        map.once("remove", () => window.removeEventListener("resize", fit));
        map.on("load", () => {
          loaded = true;
          clearTimeout(giveUp);
          if (cancelled || !map) return;
          setStatus("ready");
          setReady({ map, lib });
        });
      } catch {
        if (!cancelled) setStatus("unavailable");
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(giveUp);
      map?.remove();
      setReady(null);
    };
  }, [config.styleUrl]);

  return { container, status, map: ready?.map ?? null, lib: ready?.lib ?? null };
}
