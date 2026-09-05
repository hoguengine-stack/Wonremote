export const MOBILE_VIEWER_PATH = "/viewer";

export function isMobileViewerPath(pathname: string): boolean {
  return pathname.replace(/\/+$/, "") === MOBILE_VIEWER_PATH;
}
