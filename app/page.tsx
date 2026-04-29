"use client";

import dynamic from "next/dynamic";

// ssr: false — Three.js uses browser-only APIs (window, WebGL, devicePixelRatio).
// Next.js pre-renders on the server by default; this disables that for this component.
const SquishySim = dynamic(() => import("@/components/SquishySim"), {
  ssr: false,
  loading: () => (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "center",
      height: "100vh", color: "#ffd700",
      fontFamily: "Courier New, monospace", fontSize: "13px", letterSpacing: "3px",
    }}>
      LOADING SIM...
    </div>
  ),
});

export default function Home() {
  return <SquishySim />;
}
