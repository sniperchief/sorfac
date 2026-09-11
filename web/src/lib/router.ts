// A two-route router, hand-rolled because two routes do not justify a library.
//
// Path-based rather than hash-based, because the page already uses hash links
// for section navigation. The Node server and Vite both fall back to index.html
// for unknown paths, so a deep link to /analyze loads correctly on a refresh.

import { useCallback, useEffect, useState } from "react";

export type Route = { name: "home" } | { name: "analyze"; price: number | null };

const ANALYZE = "/analyze";

/** Read a route out of a URL. Unknown paths are the landing page. */
export function parseRoute(pathname: string, search = ""): Route {
  if (!pathname.replace(/\/+$/, "").endsWith(ANALYZE)) return { name: "home" };
  const raw = new URLSearchParams(search).get("price");
  const n = raw === null ? Number.NaN : Number(raw);
  return { name: "analyze", price: Number.isFinite(n) && n >= 1 && n <= 99 ? Math.round(n) : null };
}

export const hrefFor = (route: Route): string =>
  route.name === "home" ? "/" : route.price == null ? ANALYZE : `${ANALYZE}?price=${route.price}`;

export function useRoute(): { route: Route; go: (r: Route, replace?: boolean) => void } {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined" ? { name: "home" } : parseRoute(window.location.pathname, window.location.search),
  );

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((r: Route, replace = false) => {
    const href = hrefFor(r);
    if (typeof window !== "undefined") {
      window.history[replace ? "replaceState" : "pushState"]({}, "", href);
      if (!replace) window.scrollTo({ top: 0, behavior: "auto" });
    }
    setRoute(r);
  }, []);

  return { route, go };
}

/**
 * Intercept a same-origin link so it navigates without a page load. Modified
 * clicks and new-tab gestures are left to the browser, as they should be.
 */
export function linkHandler(go: (r: Route) => void, to: Route) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(to);
  };
}
