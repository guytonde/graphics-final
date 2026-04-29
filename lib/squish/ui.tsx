"use client";

import type { CSSProperties, MutableRefObject, ReactNode } from "react";
import { useRef } from "react";

import type { Actions, Config } from "./sim-core";
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
  statsRef: MutableRefObject<{ springs: number; broken: number; pct: string; status: string }>;
}) {
  const st = statsRef.current;
  return (
    <div style={s.hud}>
      <h2 style={s.hudTitle}>⬡ Squishy Fracture Sim</h2>
      <p style={s.row}>Springs : <b style={s.gold}>{st.springs || "—"}</b></p>
      <p style={s.row}>Broken : <b style={s.gold}>{st.broken}</b> (<b style={s.gold}>{st.pct}</b>)</p>
      <p style={s.row}>Status : <b style={s.gold}>{st.status}</b></p>
    </div>
  );
}

export function SliderPanel({ cfg }: { cfg: MutableRefObject<Config> }) {
  return (
    <div style={s.panel}>
      <SliderRow label="Stiffness" min={50} max={1500} step={25} defaultValue={380} fmt={(v) => String(v)} onChange={(v) => (cfg.current.stiffness = v)} />
      <SliderRow label="Damping" min={88} max={99} step={1} defaultValue={95} fmt={(v) => (v / 100).toFixed(2)} onChange={(v) => (cfg.current.damping = v / 100)} />
      <SliderRow label="Break %" min={10} max={200} step={5} defaultValue={60} fmt={(v) => `${v}%`} onChange={(v) => (cfg.current.breakRatio = v / 100)} />
      <SliderRow label="Substeps" min={1} max={20} step={1} defaultValue={8} fmt={(v) => String(v)} onChange={(v) => (cfg.current.substeps = v)} />
    </div>
  );
}

export function ShapeBar({ onShape }: { onShape: (shape: ShapeName) => void }) {
  return (
    <div style={{ ...s.bar, bottom: 64 }}>
      <Btn onClick={() => onShape("cube")}>⬛ Cube</Btn>
      <Btn onClick={() => onShape("sphere")}>⬤ Sphere</Btn>
      <Btn onClick={() => onShape("tower")}>▮ Tower</Btn>
    </div>
  );
}

export function ActionBar({ actionsRef }: { actionsRef: MutableRefObject<Actions | null> }) {
  return (
    <>
      <p style={s.hint}>Drag to orbit · Scroll to zoom · Click to poke</p>
      <div style={s.bar}>
        <Btn onClick={() => actionsRef.current?.drop()}>▼ Drop</Btn>
        <Btn onClick={() => actionsRef.current?.smash()}>💥 Smash</Btn>
        <Btn onClick={() => actionsRef.current?.melt()}>~ Melt</Btn>
        <Btn onClick={() => actionsRef.current?.toggleSprings()}>⊞ Springs</Btn>
        <Btn onClick={() => actionsRef.current?.toggleWireframe()}>◈ Wire</Btn>
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
  onChange,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  fmt: (v: number) => string;
  onChange: (v: number) => void;
}) {
  const valRef = useRef<HTMLSpanElement>(null);

  return (
    <div style={s.slRow}>
      <label style={{ textTransform: "uppercase" }}>{label}</label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        defaultValue={defaultValue}
        style={{ width: 90, accentColor: "#ffd700", cursor: "pointer" }}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (valRef.current) valRef.current.textContent = fmt(v);
          onChange(v);
        }}
      />
      <span ref={valRef} style={s.slVal}>{fmt(defaultValue)}</span>
    </div>
  );
}

function Btn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} style={s.btn} onMouseEnter={hoverIn} onMouseLeave={hoverOut}>
      {children}
    </button>
  );
}

const s: Record<string, CSSProperties> = {
  hud: { position: "fixed", top: 20, left: 20, fontFamily: mono, zIndex: 10, pointerEvents: "none" },
  hudTitle: { fontSize: 13, letterSpacing: 3, textTransform: "uppercase", marginBottom: 14, fontWeight: "bold", color: "#ffd700" },
  row: { fontSize: 11, color: "#777", margin: "4px 0" },
  gold: { color: "#ffd700" },
  panel: { position: "fixed", top: 20, right: 20, zIndex: 10, display: "flex", flexDirection: "column", gap: 14, alignItems: "flex-end" },
  slRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 11, letterSpacing: 1, color: "#666", fontFamily: mono },
  slVal: { color: "#ffd700", minWidth: 38, textAlign: "right", fontFamily: mono },
  hint: { position: "fixed", bottom: 110, left: "50%", transform: "translateX(-50%)", fontFamily: mono, fontSize: 10, color: "rgba(255,215,0,0.28)", letterSpacing: 2, textTransform: "uppercase", whiteSpace: "nowrap", pointerEvents: "none" },
  bar: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", display: "flex", gap: 10, zIndex: 10 },
  btn: { background: "rgba(255,215,0,0.07)", border: "1px solid rgba(255,215,0,0.35)", color: "#ffd700", padding: "9px 18px", fontFamily: mono, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", cursor: "pointer", transition: "background 0.15s" },
};