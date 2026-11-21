/**
 * Stands in for `pyodide-assets.ts` in the offline single-file build.
 *
 * There, every byte asset is already inlined into the page as base64 (see
 * `inline-assets.ts`), so nothing fetches a URL. Keeping the `?url` imports
 * would be worse than useless: `vite-plugin-singlefile` sets
 * `assetsInlineLimit` to infinity, so each one becomes a base64 data: URI
 * *inside* the already-base64 inline worker — the same 12 MB encoded twice.
 */

export const ASSET_URL: Record<string, string> = {};
