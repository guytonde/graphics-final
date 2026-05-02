"use client";

import { useEffect, useRef } from "react";
import { colorForId } from "../lib/squish/colors";
import { PARTICLE_RADIUS } from "../lib/squish/contact";
import { createSceneDiagnostics } from "../lib/squish/contact";
import { applyOrientationToPose, getPoseBounds, getPoseCenter, translatePose } from "../lib/squish/orientation";
import { FLOOR_Y, makeActions, type Actions } from "../lib/squish/sim-core";
import { createRenderer } from "../lib/squish/renderer";
import { buildShape } from "../lib/squish/shapes";
import { DEFAULT_PRISM_DIMENSIONS, type Config, type Orientation, type PrismDimensions, type ShapeName, type SimState } from "../lib/squish/types";
import { HUD, ShapeBar, SliderPanel, ActionBar } from "../lib/squish/ui";

type Stats = {
  bodies: number;
  springs: number;
  broken: number;
  pct: string;
  status: string;
};

type DebugSnapshot = {
  bodies: Array<{
    id: number;
    shape: ShapeName;
    dropped: boolean;
    center: ReturnType<typeof getPoseCenter>;
    bounds: ReturnType<typeof getPoseBounds>;
  }>;
  camera: {
    theta: number;
    phi: number;
    dist: number;
    target: [number, number, number];
  } | null;
  diagnostics: ReturnType<typeof createSceneDiagnostics>;
};

type SquishyDebugApi = {
  clear: () => void;
  autobuild: () => void;
  setShape: (shape: ShapeName) => void;
  setPrismDimensions: (dimensions: Partial<PrismDimensions>) => void;
  setOrientation: (orientation: Partial<Orientation>) => void;
  spawn: (mode?: "drop" | "smash") => void;
  toggleWireframe: () => void;
  toggleSprings: () => void;
  snapshot: () => DebugSnapshot;
};

declare global {
  interface Window {
    __SQUISHY_DEBUG__?: SquishyDebugApi;
  }
}

const SMASH_LAUNCH_SPEED = 0.95;
const DEFAULT_JENGA_LAYER_COUNT = 5;
const MIN_JENGA_LAYER_COUNT = 1;
const MAX_JENGA_LAYER_COUNT = 18;
const JENGA_BLOCKS_PER_LAYER = 3;
const JENGA_Y_TURN: Orientation = { x: 0, y: 90, z: 0 };
const JENGA_GROUND_PARTICLE_Y = FLOOR_Y + PARTICLE_RADIUS;

export default function SquishySim() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = useRef<Config>({ stiffness: 1500, damping: 0.99, breakRatio: 2, substeps: 10 });
  const actionsRef = useRef<Actions | null>(null);
  const statsRef = useRef<Stats>({ bodies: 1, springs: 0, broken: 0, pct: "0%", status: "READY" });
  const orientation = useRef<Orientation>({ x: 0, y: 0, z: 0 });
  const jengaLayerCount = useRef(DEFAULT_JENGA_LAYER_COUNT);
  const prismDimensions = useRef<PrismDimensions>({ ...DEFAULT_PRISM_DIMENSIONS });
  const selectedShape = useRef<ShapeName>("jenga");
  const previewId = useRef(1);
  const nextId = useRef(2);
  const bodiesRef = useRef<SimState[]>([]);
  const basePoseRef = useRef<Float32Array | null>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer> | null>(null);

  const getDroppedBodies = () => bodiesRef.current.filter((body) => body.dropped);
  const getPreview = () => bodiesRef.current.find((body) => !body.dropped) ?? null;

  const updateStats = () => {
    const bodies = bodiesRef.current;
    const springs = bodies.reduce((sum, body) => sum + body.springs.length, 0);
    const broken = bodies.reduce((sum, body) => sum + body.springs.filter((spring) => spring.broken).length, 0);
    const hasDroppedBody = bodies.some((body) => body.dropped);
    statsRef.current = {
      bodies: bodies.length,
      springs,
      broken,
      pct: springs ? `${(broken / springs * 100).toFixed(1)}%` : "0%",
      status: hasDroppedBody ? statsRef.current.status : "READY",
    };
  };

  const stagePreviewBody = (preview: SimState) => {
    const basePose = basePoseRef.current;
    if (!basePose) return;

    preview.pos.set(basePose);
    preview.prev.set(basePose);

    const [cx, cy, cz] = getPoseCenter(basePose);
    const rx = orientation.current.x * Math.PI / 180;
    const ry = orientation.current.y * Math.PI / 180;
    const rz = orientation.current.z * Math.PI / 180;
    const sx = Math.sin(rx);
    const cxr = Math.cos(rx);
    const sy = Math.sin(ry);
    const cyr = Math.cos(ry);
    const sz = Math.sin(rz);
    const czr = Math.cos(rz);

    for (let i = 0; i < basePose.length; i += 3) {
      let x = basePose[i] - cx;
      let y = basePose[i + 1] - cy;
      let z = basePose[i + 2] - cz;

      const y1 = y * cxr - z * sx;
      const z1 = y * sx + z * cxr;
      y = y1;
      z = z1;

      const x2 = x * cyr + z * sy;
      const z2 = -x * sy + z * cyr;
      x = x2;
      z = z2;

      const x3 = x * czr - y * sz;
      const y3 = x * sz + y * czr;

      preview.pos[i] = cx + x3;
      preview.pos[i + 1] = cy + y3;
      preview.pos[i + 2] = cz + z;
      preview.prev[i] = preview.pos[i];
      preview.prev[i + 1] = preview.pos[i + 1];
      preview.prev[i + 2] = preview.pos[i + 2];
    }

    const droppedBodies = getDroppedBodies();
    if (!droppedBodies.length) return;

    let worldTop = -Infinity;
    for (const body of droppedBodies) {
      const bounds = getPoseBounds(body.pos);
      if (bounds.maxY > worldTop) worldTop = bounds.maxY;
    }

    const previewBounds = getPoseBounds(preview.pos);
    const desiredMinY = worldTop + 0.8;
    if (desiredMinY > previewBounds.minY) {
      translatePose(preview.pos, preview.prev, 0, desiredMinY - previewBounds.minY, 0);
    }
  };

  const createBody = (shape: ShapeName, id: number, dropped: boolean) => (
    buildShape(shape, { id, color: colorForId(id), dropped }, prismDimensions.current)
  );

  const orientBody = (body: SimState, nextOrientation: Orientation) => {
    const source = new Float32Array(body.pos);
    applyOrientationToPose(source, body.pos, body.prev, nextOrientation);
  };

  const placeBody = (body: SimState, centerX: number, minY: number, centerZ: number) => {
    const [cx, , cz] = getPoseCenter(body.pos);
    const bounds = getPoseBounds(body.pos);
    translatePose(body.pos, body.prev, centerX - cx, minY - bounds.minY, centerZ - cz);
  };

  const createPreviewBody = (shape: ShapeName, id = previewId.current) => {
    const preview = createBody(shape, id, false);
    basePoseRef.current = new Float32Array(preview.pos);
    stagePreviewBody(preview);
    return preview;
  };

  const loadScene = () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.load(bodiesRef.current);
    updateStats();
  };

  const applyPrismDimensions = (dimensions: Partial<PrismDimensions>) => {
    prismDimensions.current = {
      ...prismDimensions.current,
      ...dimensions,
    };

    if (selectedShape.current === "prism" && getPreview()) {
      replacePreview("prism");
    }
  };

  const getDebugSnapshot = (): DebugSnapshot => ({
    bodies: bodiesRef.current.map((body) => ({
      id: body.id,
      shape: body.shape,
      dropped: body.dropped,
      center: getPoseCenter(body.pos),
      bounds: getPoseBounds(body.pos),
    })),
    camera: rendererRef.current?.getCameraState() ?? null,
    diagnostics: createSceneDiagnostics(bodiesRef.current),
  });

  const replacePreview = (shape: ShapeName = selectedShape.current) => {
    const preview = createPreviewBody(shape);
    bodiesRef.current = [...getDroppedBodies(), preview];
    loadScene();
  };

  const handleOrientationChange = (axis: keyof Orientation, value: number) => {
    orientation.current[axis] = value;

    const renderer = rendererRef.current;
    if (renderer) renderer.setPreviewOrientation(orientation.current);

    const preview = getPreview();
    if (preview) {
      stagePreviewBody(preview);
    }
  };

  const handlePrismDimensionChange = (axis: keyof PrismDimensions, value: number) => {
    applyPrismDimensions({ [axis]: value });
  };

  const handleJengaLayerCountChange = (value: number) => {
    jengaLayerCount.current = Math.max(MIN_JENGA_LAYER_COUNT, Math.min(MAX_JENGA_LAYER_COUNT, Math.round(value)));
  };

  const handleShapeChange = (shape: ShapeName) => {
    const preview = getPreview();
    if (preview?.shape === shape) {
      bodiesRef.current = getDroppedBodies();
      loadScene();
      return;
    }

    selectedShape.current = shape;
    if (preview) {
      replacePreview(shape);
    } else {
      const nextPreview = createPreviewBody(shape);
      bodiesRef.current = [...getDroppedBodies(), nextPreview];
      loadScene();
    }
  };

  const autobuildJengaTower = () => {
    const templateX = buildShape("jenga", { dropped: true }, prismDimensions.current);
    const templateZ = buildShape("jenga", { dropped: true }, prismDimensions.current);
    orientBody(templateZ, JENGA_Y_TURN);

    const xBounds = getPoseBounds(templateX.pos);
    const zBounds = getPoseBounds(templateZ.pos);
    const layerStep = (xBounds.maxY - xBounds.minY) + PARTICLE_RADIUS * 2;
    const xLayerSpacing = (xBounds.maxZ - xBounds.minZ) + PARTICLE_RADIUS * 2;
    const zLayerSpacing = (zBounds.maxX - zBounds.minX) + PARTICLE_RADIUS * 2;

    const droppedBodies: SimState[] = [];
    let id = 1;

    for (let layer = 0; layer < jengaLayerCount.current; layer++) {
      const targetMinY = JENGA_GROUND_PARTICLE_Y + layer * layerStep;
      const rotated = layer % 2 === 1;

      for (let slot = 0; slot < JENGA_BLOCKS_PER_LAYER; slot++) {
        const body = createBody("jenga", id++, true);
        if (rotated) orientBody(body, JENGA_Y_TURN);

        const offset = slot - 1;
        const centerX = rotated ? offset * zLayerSpacing : 0;
        const centerZ = rotated ? 0 : offset * xLayerSpacing;
        placeBody(body, centerX, targetMinY, centerZ);
        droppedBodies.push(body);
      }
    }

    previewId.current = id;
    nextId.current = id + 1;
    bodiesRef.current = droppedBodies;
    statsRef.current.status = "AUTOBUILT";
    loadScene();
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const renderer = createRenderer(canvas);
    rendererRef.current = renderer;
    renderer.setPreviewOrientation(orientation.current);

    bodiesRef.current = [];
    loadScene();

    const spawnPreview = (mode: "drop" | "smash") => {
      const existingPreview = getPreview();
      const preview = existingPreview ?? createPreviewBody(selectedShape.current, previewId.current);

      preview.dropped = true;
      if (mode === "smash") {
        for (let i = 0; i < preview.N; i++) {
          const base = i * 3;
          preview.prev[base] = preview.pos[base];
          preview.prev[base + 1] = preview.pos[base + 1] + SMASH_LAUNCH_SPEED;
          preview.prev[base + 2] = preview.pos[base + 2];
        }
      }

      const droppedBodies = existingPreview ? getDroppedBodies() : [...getDroppedBodies(), preview];
      previewId.current = nextId.current++;
      if (mode === "drop") {
        const nextPreview = createPreviewBody(selectedShape.current);
        bodiesRef.current = [...droppedBodies, nextPreview];
      } else {
        bodiesRef.current = droppedBodies;
      }
      statsRef.current.status = mode === "smash" ? "SMASHED" : "SIMULATING";
      loadScene();
    };

    actionsRef.current = makeActions({
      drop: () => spawnPreview("drop"),
      smash: () => spawnPreview("smash"),
      autobuild: () => autobuildJengaTower(),
      melt: () => {
        for (const body of getDroppedBodies()) {
          body.springs.forEach((spring) => {
            spring.broken = true;
          });
        }
        statsRef.current.status = "MELTED";
        updateStats();
      },
      clear: () => {
        bodiesRef.current = [];
        statsRef.current.status = "READY";
        loadScene();
      },
      toggleSprings: () => renderer.toggleSprings(),
      toggleWireframe: () => renderer.toggleWireframe(),
    });

    const resize = () => renderer.resize();
    window.addEventListener("resize", resize);
    resize();

    window.__SQUISHY_DEBUG__ = {
      clear: () => actionsRef.current?.clear(),
      autobuild: () => actionsRef.current?.autobuild(),
      setShape: (shape) => handleShapeChange(shape),
      setPrismDimensions: (dimensions) => applyPrismDimensions(dimensions),
      setOrientation: (nextOrientation) => {
        for (const [axis, value] of Object.entries(nextOrientation) as Array<[keyof Orientation, number]>) {
          handleOrientationChange(axis, value);
        }
      },
      spawn: (mode = "drop") => {
        if (mode === "smash") {
          actionsRef.current?.smash();
          return;
        }
        actionsRef.current?.drop();
      },
      toggleWireframe: () => actionsRef.current?.toggleWireframe(),
      toggleSprings: () => actionsRef.current?.toggleSprings(),
      snapshot: () => getDebugSnapshot(),
    };

    let tick = 0;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      renderer.update(cfg.current);
      if (tick++ % 10 === 0) updateStats();
    };
    loop();

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      delete window.__SQUISHY_DEBUG__;
      rendererRef.current = null;
      bodiesRef.current = [];
      basePoseRef.current = null;
      renderer.dispose();
    };
  }, []);

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden" }}>
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background: [
            "radial-gradient(ellipse at 14% 18%, rgba(255,255,255,0.98) 0 5.5%, rgba(255,255,255,0) 11%)",
            "radial-gradient(ellipse at 21% 21%, rgba(255,255,255,0.98) 0 7.5%, rgba(255,255,255,0) 13%)",
            "radial-gradient(ellipse at 29% 18%, rgba(255,255,255,0.98) 0 5.8%, rgba(255,255,255,0) 11.5%)",
            "radial-gradient(ellipse at 61% 14%, rgba(255,255,255,0.98) 0 5.2%, rgba(255,255,255,0) 10.4%)",
            "radial-gradient(ellipse at 68% 17%, rgba(255,255,255,0.98) 0 7.2%, rgba(255,255,255,0) 12.8%)",
            "radial-gradient(ellipse at 76% 14%, rgba(255,255,255,0.98) 0 5.4%, rgba(255,255,255,0) 10.8%)",
            "radial-gradient(ellipse at 37% 33%, rgba(255,255,255,0.96) 0 4.8%, rgba(255,255,255,0) 9.8%)",
            "radial-gradient(ellipse at 43% 35%, rgba(255,255,255,0.98) 0 6.4%, rgba(255,255,255,0) 11.6%)",
            "radial-gradient(ellipse at 50% 33%, rgba(255,255,255,0.96) 0 4.9%, rgba(255,255,255,0) 9.9%)",
            "linear-gradient(180deg, #52a8ff 0%, #81d0ff 58%, #dff4ff 100%)",
          ].join(", "),
        }}
      />
      <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", background: "transparent" }} />
      <HUD statsRef={statsRef} />
      <SliderPanel
        cfg={cfg}
        defaultJengaLayerCount={DEFAULT_JENGA_LAYER_COUNT}
        minJengaLayerCount={MIN_JENGA_LAYER_COUNT}
        maxJengaLayerCount={MAX_JENGA_LAYER_COUNT}
        onJengaLayerCountChange={handleJengaLayerCountChange}
        onOrientationChange={handleOrientationChange}
        onPrismDimensionChange={handlePrismDimensionChange}
      />
      <ShapeBar onShape={handleShapeChange} />
      <ActionBar actionsRef={actionsRef} />
    </div>
  );
}
