import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev-only overlay (never renders in the production build this app
  // actually deploys, per the Azure Container App output above). Moved
  // off bottom-left (2026-07-30) since it sat close to the plan page's
  // day-tab row on mobile, then off bottom-right (2026-08-09) once the
  // chat assistant's own floating launcher button claimed that corner --
  // both bottom corners are now real page UI, so top-right (just plain
  // "Account"/"Log out" links with room to spare) is the one corner
  // nothing else on this page anchors to.
  devIndicators: { position: "top-right" },
};

export default nextConfig;
