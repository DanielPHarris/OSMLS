"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Marker } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import type { MapConfig } from "@/lib/map-config";
import { useMap } from "./use-map";

const parse = (s: string, limit: number) => {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) && Math.abs(n) <= limit ? n : null;
};
const fixed = (n: number) => n.toFixed(6);

/**
 * Sets a listing's map position. The pin and the two number fields always show
 * the same place: moving one updates the other.
 */
export function LocationPicker({
  config,
  initialLatitude,
  initialLongitude,
  errors,
}: {
  config: MapConfig;
  initialLatitude: string;
  initialLongitude: string;
  errors: { Latitude?: string; Longitude?: string };
}) {
  const [latitude, setLatitude] = useState(initialLatitude);
  const [longitude, setLongitude] = useState(initialLongitude);
  const lat = parse(latitude, 90);
  const lng = parse(longitude, 180);
  const hasPin = lat != null && lng != null;

  // Where the map opens: on the existing pin, or the default area.
  const [start] = useState(() =>
    hasPin ? { latitude: lat, longitude: lng, zoom: 15 } : config.defaultView,
  );
  const { container, status, map, lib } = useMap(config, start);
  const marker = useRef<Marker | null>(null);

  // Clicking the map places the pin.
  useEffect(() => {
    if (!map) return;
    const onClick = (e: { lngLat: { lat: number; lng: number } }) => {
      setLatitude(fixed(e.lngLat.lat));
      setLongitude(fixed(e.lngLat.lng));
    };
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [map]);

  // Keep the pin where the fields say it is.
  useEffect(() => {
    if (!map || !lib) return;
    if (!hasPin) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    if (!marker.current) {
      const created = new lib.Marker({ draggable: true, color: "#14506e" });
      created.on("dragend", () => {
        const at = created.getLngLat();
        setLatitude(fixed(at.lat));
        setLongitude(fixed(at.lng));
      });
      marker.current = created.setLngLat([lng, lat]).addTo(map);
    } else {
      marker.current.setLngLat([lng, lat]);
    }
    if (!map.getBounds().contains([lng, lat])) map.easeTo({ center: [lng, lat] });
  }, [map, lib, hasPin, lat, lng]);

  useEffect(
    () => () => {
      marker.current?.remove();
      marker.current = null;
    },
    [map],
  );

  const field = (name: "Latitude" | "Longitude", value: string, set: (v: string) => void) => (
    <label className="label">
      {name}
      <input
        name={name}
        value={value}
        onChange={(e) => set(e.target.value)}
        inputMode="decimal"
        aria-invalid={!!errors[name]}
        aria-describedby={errors[name] ? `${name}-error` : undefined}
        className="field"
      />
      {errors[name] && (
        <p className="error" id={`${name}-error`}>
          {errors[name]}
        </p>
      )}
    </label>
  );

  return (
    <fieldset className="card">
      <legend className="px-1 text-sm font-semibold">Map location</legend>
      <p className="text-sm text-muted">
        {status === "unavailable"
          ? "The map is unavailable right now. You can still type the coordinates, or leave them blank."
          : "Click the map to place the pin, or drag the pin to move it. Optional."}
      </p>
      {status !== "unavailable" && (
        <div
          ref={container}
          data-testid="location-map"
          data-map-status={status}
          role="application"
          aria-label="Map for placing the pin. The coordinate fields below do the same job."
          className="mt-3 h-72 w-full overflow-hidden rounded-md border border-line"
        />
      )}
      <div className="mt-3 grid items-end gap-4 sm:grid-cols-3">
        {field("Latitude", latitude, setLatitude)}
        {field("Longitude", longitude, setLongitude)}
        <button
          type="button"
          className="btn-secondary"
          disabled={latitude === "" && longitude === ""}
          onClick={() => {
            setLatitude("");
            setLongitude("");
          }}
        >
          Remove location
        </button>
      </div>
    </fieldset>
  );
}
