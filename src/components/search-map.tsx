"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Marker, Popup } from "maplibre-gl";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";
import type { MapBounds } from "@/lib/listings";
import type { MapConfig } from "@/lib/map-config";
import { useMap } from "./use-map";

export type MapPin = {
  key: string;
  id: string;
  latitude: number;
  longitude: number;
  address: string;
  price: string;
  status: string;
};

function popupContent(pin: MapPin): HTMLElement {
  // Built with textContent so listing text is never treated as HTML.
  const box = document.createElement("div");
  box.className = "text-sm";
  const link = document.createElement("a");
  link.href = `/listings/${pin.key}`;
  link.textContent = pin.id;
  link.className = "font-semibold text-brand underline";
  const address = document.createElement("div");
  address.textContent = pin.address;
  const facts = document.createElement("div");
  facts.textContent = `${pin.price} · ${pin.status}`;
  facts.className = "font-medium";
  box.append(link, address, facts);
  return box;
}

export function SearchMap({
  config,
  pins,
  activeBounds,
  statuses,
}: {
  config: MapConfig;
  pins: MapPin[];
  /** Set when the results are limited to a map area. */
  activeBounds: MapBounds | null;
  /** The statuses the current results are filtered by. */
  statuses: readonly string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { container, status, map, lib } = useMap(config, config.defaultView);
  const markers = useRef<Marker[]>([]);
  const popup = useRef<Popup | null>(null);

  // Draw one marker per listing. Each is a real button, so it can be reached and
  // opened from the keyboard.
  useEffect(() => {
    if (!map || !lib) return;
    for (const pin of pins) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "osmls-pin";
      button.setAttribute("aria-label", `${pin.id}, ${pin.address}, ${pin.price}, ${pin.status}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        popup.current?.remove();
        popup.current = new lib.Popup({ offset: 14, maxWidth: "260px" })
          .setLngLat([pin.longitude, pin.latitude])
          .setDOMContent(popupContent(pin))
          .addTo(map);
      });
      markers.current.push(
        new lib.Marker({ element: button }).setLngLat([pin.longitude, pin.latitude]).addTo(map),
      );
    }
    return () => {
      popup.current?.remove();
      for (const marker of markers.current) marker.remove();
      markers.current = [];
    };
  }, [map, lib, pins]);

  // Show the searched area if there is one; otherwise frame the results.
  const viewKey = activeBounds
    ? `area:${Object.values(activeBounds).join(",")}`
    : `pins:${pins.map((p) => p.key).join(",")}`;
  useEffect(() => {
    if (!map || !lib) return;
    if (activeBounds) {
      const b = activeBounds;
      map.fitBounds([[b.west, b.south], [b.east, b.north]], { padding: 0, animate: false });
    } else if (pins.length > 0) {
      const box = new lib.LngLatBounds();
      for (const pin of pins) box.extend([pin.longitude, pin.latitude]);
      map.fitBounds(box, { padding: 48, maxZoom: 14, animate: false });
    }
    // viewKey stands in for activeBounds and pins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, lib, viewKey]);

  const withParams = (change: (p: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString());
    // A first visit shows the default statuses without naming them in the URL.
    // Name them now, or marking the search as submitted would widen it to every status.
    if (!params.has("s")) for (const status of statuses) params.append("status", status);
    params.set("s", "1");
    change(params);
    return `${pathname}?${params}`;
  };

  const searchThisArea = () => {
    if (!map) return;
    const b = map.getBounds();
    const area = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]
      .map((n, i) => Math.max(i % 2 ? -90 : -180, Math.min(i % 2 ? 90 : 180, n)).toFixed(5))
      .join(",");
    router.push(withParams((p) => p.set("bounds", area)));
  };

  if (status === "unavailable")
    return (
      <p role="status" className="card text-sm text-muted">
        The map is unavailable right now. The search and the results below still work.
      </p>
    );

  return (
    <section className="card !p-3" aria-label="Map of results">
      <div className="mb-2 flex flex-wrap items-center gap-3">
        <button type="button" className="btn" onClick={searchThisArea} disabled={status !== "ready"}>
          Search this area
        </button>
        {activeBounds && (
          <Link href={withParams((p) => p.delete("bounds"))} className="btn-secondary">
            Clear area
          </Link>
        )}
        <span className="text-xs text-muted">
          Move or zoom the map, then search this area. Every listing on the map is also in the table below.
        </span>
      </div>
      <div
        ref={container}
        data-testid="search-map"
        data-map-status={status}
        className="h-[26rem] w-full overflow-hidden rounded-md border border-line"
      />
    </section>
  );
}
