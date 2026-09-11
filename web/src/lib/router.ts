// A two-route router, hand-rolled because two routes do not justify a library.
//
// Path-based rather than hash-based, because the landing page uses hash links
// for section navigation. The Node server and Vercel both fall back to the app
// shell for /analyze, so a deep link loads correctly on a refresh.
//
// The landing page's sections are addressed by a hash on the home route. That
// matters because the header offers those links from the workspace too, where
// the sections are not mounted: the link has to change route first and scroll
// afterwards, not just set a hash that nothing on the page answers to.

import { useCallback, useEffect, useState } from "react";

export type Route =
  | { name: "home"; section?: string | null }
  | { name: "analyze"; price: number | null };

const ANALYZE = "/analyze";

/** Section ids the landing page renders, so a hash cannot point at nothing. */
export const SECTIONS = ["finding", "tested", "method", "markets", "experiment", "integrity"] as const;

const cleanSection = (hash: string): string | null => {
  const id = hash.replace(/^#/, "");
  return (SECTIONS as readonly string[]).includes(id) ? id : null;
};

/** Read a route out of a URL. Unknown paths are the landing page. */
export function parseRoute(pathname: string, search = "", hash = ""): Route {
  if (!pathname.replace(/\/+$/, "").endsWith(ANALYZE)) return { name: "home", section: cleanSection(hash) };
  const raw = new URLSearchParams(search).get("price");
  const n = raw === null ? Number.NaN : Number(raw);
  return { name: "analyze", price: Number.isFinite(n) && n >= 1 && n <= 99 ? Math.round(n) : null };
}

export const hrefFor = (route: Route): string =>
  route.name === "home"
    ? route.section
      ? `/#${route.section}`
      : "/"
    : route.price == null
      ? ANALYZE
      : `${ANALYZE}?price=${route.price}`;

/**
 * Scroll to a section once it exists.
 *
 * Coming from the workspace, the landing page has not mounted at the moment the
 * click is handled, so the element is not there yet. Two frames is enough for
 * React to commit; if the id still is not present, do nothing rather than
 * scrolling somewhere arbitrary.
 */
function scrollToSection(id: string) {
  if (typeof window === "undefined") return;
  const jump = () => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  requestAnimationFrame(() => {
    if (document.getElementById(id)) jump();
    else requestAnimationFrame(jump);
  });
}

export function useRoute(): { route: Route; go: (r: Route, replace?: boolean) => void } {
  const [route, setRoute] = useState<Route>(() =>
    typeof window === "undefined"
      ? { name: "home" }
      : parseRoute(window.location.pathname, window.location.search, window.location.hash),
  );

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname, window.location.search, window.location.hash));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((r: Route, replace = false) => {
    if (typeof window !== "undefined") {
      window.history[replace ? "replaceState" : "pushState"]({}, "", hrefFor(r));
    }
    setRoute(r);
    if (typeof window === "undefined") return;
    if (r.name === "home" && r.section) scrollToSection(r.section);
    else if (!replace) window.scrollTo({ top: 0, behavior: "auto" });
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
