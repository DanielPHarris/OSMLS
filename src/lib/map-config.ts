import { DEFAULT_MAP_STYLE_URL, DEFAULT_MAP_VIEW } from "./rules/local";

export type MapConfig = { styleUrl: string; defaultView: typeof DEFAULT_MAP_VIEW };

/**
 * Read on the server for each request and handed to the map components, so the
 * map source can be changed without rebuilding the application.
 */
export function getMapConfig(): MapConfig {
  return {
    styleUrl: process.env.MAP_STYLE_URL?.trim() || DEFAULT_MAP_STYLE_URL,
    defaultView: DEFAULT_MAP_VIEW,
  };
}
