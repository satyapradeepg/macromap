import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // Dev-only overlay (never renders in the production build this app
  // actually deploys, per the Azure Container App output above) -- moved
  // off bottom-left (2026-07-30 UI pass) since it sat close to the plan
  // page's day-tab row on a narrow mobile viewport during local testing.
  devIndicators: { position: "bottom-right" },
};

export default nextConfig;
