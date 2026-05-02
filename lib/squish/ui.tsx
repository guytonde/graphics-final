"use client";

import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { useRef } from "react";

import type { Actions } from "./sim-core";
import { DEFAULT_PRISM_DIMENSIONS, type Config, type Orientation, type PrismDimensions } from "./types";
import type { ShapeName } from "./types";

const mono = "'Courier New', monospace";

const hoverIn = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.currentTarget.style.background = "rgba(255,215,0,0.22)";
};

const hoverOut = (e: React.MouseEvent<HTMLButtonElement>) => {
  e.currentTarget.style.background = "rgba(255,215,0,0.07)";
};

export function HUD({
  statsRef,
}: {
  statsRef: MutableRefObject<{ bodies: number; springs: number; broken: number; pct: string; status: string }>;
}) {
  const st = statsRef.current;
  return (
    <div style={s.hud}>
      <h2 style={s.hudTitle}>⬡ Squishy Jenga</h2>
      <p style={s.row}>Objects : <b style={s.gold}>{st.bodies || "—"}</b></p>
      <p style={s.row}>Springs : <b style={s.gold}>{st.springs || "—"}</b></p>
      <p style={s.row}>Broken : <b style={s.gold}>{st.broken}</b> (<b style={s.gold}>{st.pct}</b>)</p>
      <p style={s.row}>Status : <b style={s.gold}>{st.status}</b></p>
    </div>
  );
}

export function SliderPanel({
  cfg,
  onOrientationChange,
  onPrismDimensionChange,
}: {
  cfg: MutableRefObject<Config>;
  onOrientationChange: (axis: keyof Orientation, value: number) => void;
  onPrismDimensionChange: (axis: keyof PrismDimensions, value: number) => void;
}) {
  return (
    <div style={s.panel}>
      <div style={s.group}>
        <p style={s.sectionTitle}>Physics</p>
        <SliderRow label="Stiffness" min={50} max={1500} step={25} defaultValue={1500} fmt={(v) => String(v)} onChange={(v) => (cfg.current.stiffness = v)} />
        <SliderRow label="Damping" min={88} max={99} step={1} defaultValue={99} fmt={(v) => (v / 100).toFixed(2)} onChange={(v) => (cfg.current.damping = v / 100)} />
        <SliderRow label="Break %" min={10} max={200} step={5} defaultValue={200} fmt={(v) => `${v}%`} onChange={(v) => (cfg.current.breakRatio = v / 100)} />
        <SliderRow label="Substeps" min={1} max={20} step={1} defaultValue={10} fmt={(v) => String(v)} onChange={(v) => (cfg.current.substeps = v)} />
      </div>
      <div style={s.group}>
        <p style={s.sectionTitle}>Prism</p>
        <SliderRow label="Width" min={2} max={12} step={1} defaultValue={DEFAULT_PRISM_DIMENSIONS.width} fmt={(v) => String(v)} tone="#f3c86a" onChange={(v) => onPrismDimensionChange("width", v)} />
        <SliderRow label="Height" min={2} max={14} step={1} defaultValue={DEFAULT_PRISM_DIMENSIONS.height} fmt={(v) => String(v)} tone="#ff9f68" onChange={(v) => onPrismDimensionChange("height", v)} />
        <SliderRow label="Depth" min={2} max={12} step={1} defaultValue={DEFAULT_PRISM_DIMENSIONS.depth} fmt={(v) => String(v)} tone="#7ee0ff" onChange={(v) => onPrismDimensionChange("depth", v)} />
        <p style={s.panelHint}>These sliders reshape the next prism preview before you spawn it.</p>
      </div>
      <div style={s.group}>
        <p style={s.sectionTitle}>Orientation</p>
        <SliderRow label="Rotate X" min={-180} max={180} step={5} defaultValue={0} fmt={(v) => `${v}\u00b0`} tone="#ff8585" onChange={(v) => onOrientationChange("x", v)} />
        <SliderRow label="Rotate Y" min={-180} max={180} step={5} defaultValue={0} fmt={(v) => `${v}\u00b0`} tone="#7ef7a9" onChange={(v) => onOrientationChange("y", v)} />
        <SliderRow label="Rotate Z" min={-180} max={180} step={5} defaultValue={0} fmt={(v) => `${v}\u00b0`} tone="#8ab6ff" onChange={(v) => onOrientationChange("z", v)} />
        <p style={s.panelHint}>Applied before drop. The X/Y/Z guide sticks out of the ready pose.</p>
      </div>
    </div>
  );
}

export function ShapeBar({ onShape }: { onShape: (shape: ShapeName) => void }) {
  return (
    <div style={{ ...s.bar, bottom: 64 }}>
      <Btn label="Prism" onClick={() => onShape("prism")}>▰ Prism</Btn>
      <Btn label="Sphere" onClick={() => onShape("sphere")}>⬤ Sphere</Btn>
      <Btn label="Jenga" onClick={() => onShape("jenga")}>▭ Jenga</Btn>
    </div>
  );
}

export function ActionBar({ actionsRef }: { actionsRef: MutableRefObject<Actions | null> }) {
  return (
    <>
      <p style={s.hint}>Left drag empty to orbit or a body to grab · Right drag or shift-drag to pan · Scroll to zoom</p>
      <div style={s.bar}>
        <Btn label="Spawn" onClick={() => actionsRef.current?.drop()}>▼ Spawn</Btn>
        <Btn label="Smash" onClick={() => actionsRef.current?.smash()}>💥 Smash</Btn>
        <Btn label="Autobuild" onClick={() => actionsRef.current?.autobuild()}>▤ Autobuild</Btn>
        <Btn label="Melt" onClick={() => actionsRef.current?.melt()}>~ Melt</Btn>
        <Btn label="Clear" onClick={() => actionsRef.current?.clear()}>↺ Clear</Btn>
        <Btn label="Springs" onClick={() => actionsRef.current?.toggleSprings()}>⊞ Springs</Btn>
        <Btn label="Wire" onClick={() => actionsRef.current?.toggleWireframe()}>◈ Wire</Btn>
      </div>
    </>
  );
}

function SliderRow({
  label,
  min,
  max,
  step,
  defaultValue,
  fmt,
  tone,
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  fmt: (v: number) => string;
  tone?: string;
  onChange: (v: number) => void;
}) {
  const valRef = useRef<HTMLSpanElement>(null);

  return (
    <div style={s.slRow}>
      <label style={{ textTransform: "uppercase", color: tone ?? "#666" }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={defaultValue}
        aria-label={label}
        style={{ width: 90, accentColor: tone ?? "#ffd700", cursor: "pointer" }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (valRef.current) valRef.current.textContent = fmt(v);
          onChange(v);
        }}
      />
      <span ref={valRef} style={{ ...s.slVal, color: tone ?? "#ffd700" }}>{fmt(defaultValue)}</span>
    </div>
  );
}

function Btn({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button aria-label={label} onClick={onClick} style={s.btn} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      {children}
    </button>
  );
}

const s: Record<string, CSSProperties> = {
  hud: { position: "fixed", top: 20, left: 20, fontFamily: mono, zIndex: 10, pointerEvents: "none" },
  hudTitle: { fontSize: 13, letterSpacing: 3, textTransform: "uppercase", marginBottom: 14, fontWeight: "bold", color: "#ffd700" },
  row: { fontSize: 11, color: "#777", margin: "4px 0" },
  gold: { color: "#ffd700" },
  panel: { position: "fixed", top: 20, right: 20, zIndex: 10, display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end" },
  group: { display: "flex", flexDirection: "column", gap: 12, alignItems: "flex-end", padding: "12px 12px 10px", border: "1px solid rgba(255,215,0,0.16)", background: "rgba(4,4,12,0.55)", backdropFilter: "blur(6px)" },
  sectionTitle: { width: "100%", margin: 0, color: "#ffd700", fontSize: 10, letterSpacing: 3, textTransform: "uppercase", textAlign: "left" },
  slRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 11, letterSpacing: 1, color: "#666", fontFamily: mono },
  slVal: { color: "#ffd700", minWidth: 38, textAlign: "right", fontFamily: mono },
  panelHint: { width: 228, margin: 0, color: "rgba(255,215,0,0.55)", fontSize: 9, lineHeight: 1.5, letterSpacing: 1.4, textTransform: "uppercase", textAlign: "right" },
  hint: { position: "fixed", bottom: 110, left: "50%", transform: "translateX(-50%)", fontFamily: mono, fontSize: 10, color: "rgba(255,215,0,0.28)", letterSpacing: 2, textTransform: "uppercase", whiteSpace: "nowrap", pointerEvents: "none" },
  bar: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 10, zIndex: 10 },
  btn: { background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.35)", color: "#ffd700", padding: "9px 18px", fontFamily: mono, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", transition: "background 0.15s" },
};
