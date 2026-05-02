import { expect, test, type Page } from "@playwright/test";

type Bounds = {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

type BodySnapshot = {
  id: number;
  shape: "prism" | "sphere" | "jenga";
  dropped: boolean;
  center: [number, number, number];
  bounds: Bounds;
};

type DebugSnapshot = {
  bodies: BodySnapshot[];
  springs: {
    total: number;
    broken: number;
  };
  diagnostics: {
    maxBodySpeed: number;
    maxShellBoxPenetration: number;
    maxContactBoxPenetration: number;
    maxSpherePenetration: number;
  };
};

type SquishyTestDebugApi = {
  waitFrames: (frames?: number) => Promise<void>;
  projectWorldPoint: (point: [number, number, number]) => { x: number; y: number } | null;
  snapshot: () => DebugSnapshot;
};

async function waitForDebug(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as { __SQUISHY_DEBUG__?: SquishyTestDebugApi }).__SQUISHY_DEBUG__));
  await waitFrames(page, 4);
}

async function waitFrames(page: Page, frames = 1) {
  await page.evaluate(async (count) => {
    await (window as unknown as { __SQUISHY_DEBUG__?: SquishyTestDebugApi }).__SQUISHY_DEBUG__?.waitFrames(count);
  }, frames);
}

async function snapshot(page: Page): Promise<DebugSnapshot> {
  return page.evaluate(() => (window as unknown as { __SQUISHY_DEBUG__?: SquishyTestDebugApi }).__SQUISHY_DEBUG__!.snapshot());
}

async function projectWorldPoint(page: Page, point: [number, number, number]) {
  return page.evaluate(
    (nextPoint) => (window as unknown as { __SQUISHY_DEBUG__?: SquishyTestDebugApi }).__SQUISHY_DEBUG__!.projectWorldPoint(nextPoint),
    point
  );
}

async function setRangeValue(page: Page, label: string, value: number) {
  await page.getByLabel(label).evaluate((node, nextValue) => {
    const input = node as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

function bodySize(body: BodySnapshot) {
  return {
    x: body.bounds.maxX - body.bounds.minX,
    y: body.bounds.maxY - body.bounds.minY,
    z: body.bounds.maxZ - body.bounds.minZ,
  };
}

function pickMiddleLayerFrontBlock(bodies: BodySnapshot[]) {
  const dropped = bodies.filter((body) => body.dropped);
  const ordered = [...dropped].sort((a, b) => a.center[1] - b.center[1]);
  const middle = ordered[Math.floor(ordered.length / 2)];
  const layerBodies = ordered.filter((body) => Math.abs(body.center[1] - middle.center[1]) < 0.25);
  return [...layerBodies].sort((a, b) => b.bounds.maxZ - a.bounds.maxZ)[0];
}

test("preview bodies only appear when explicitly staged", async ({ page }) => {
  await waitForDebug(page);

  await page.getByLabel("Clear").click();
  await waitFrames(page, 4);

  let state = await snapshot(page);
  expect(state.bodies.filter((body) => !body.dropped)).toHaveLength(0);

  await page.getByLabel("Jenga").click();
  await waitFrames(page, 4);

  state = await snapshot(page);
  expect(state.bodies.filter((body) => !body.dropped)).toHaveLength(1);
  expect(state.bodies.filter((body) => !body.dropped)[0]?.shape).toBe("jenga");

  await page.getByLabel("Spawn").click();
  await waitFrames(page, 8);

  state = await snapshot(page);
  expect(state.bodies.filter((body) => !body.dropped)).toHaveLength(0);
  expect(state.bodies.filter((body) => body.dropped)).toHaveLength(1);
});

test("autobuild uses the layer slider and defaults to five layers", async ({ page }) => {
  await waitForDebug(page);

  await page.getByLabel("Clear").click();
  await waitFrames(page, 2);

  await expect(page.getByLabel("Layers")).toHaveValue("5");

  await page.getByLabel("Autobuild").click();
  await waitFrames(page, 4);

  let state = await snapshot(page);
  expect(state.bodies.filter((body) => body.dropped)).toHaveLength(15);
  expect(state.bodies.filter((body) => !body.dropped)).toHaveLength(0);

  await page.getByLabel("Clear").click();
  await waitFrames(page, 2);
  await setRangeValue(page, "Layers", 7);

  await page.getByLabel("Autobuild").click();
  await waitFrames(page, 4);

  state = await snapshot(page);
  expect(state.bodies.filter((body) => body.dropped)).toHaveLength(21);
});

test("dragging a tower block pulls it out coherently without tearing it apart", async ({ page }) => {
  await waitForDebug(page);

  await page.getByLabel("Clear").click();
  await waitFrames(page, 2);
  await page.getByLabel("Autobuild").click();
  await waitFrames(page, 6);

  const before = await snapshot(page);
  const target = pickMiddleLayerFrontBlock(before.bodies);
  expect(target).toBeTruthy();

  const start = await projectWorldPoint(page, [target!.center[0], target!.center[1], target!.bounds.maxZ - 0.05]);
  const end = await projectWorldPoint(page, [target!.center[0], target!.center[1], target!.bounds.maxZ + 2.8]);
  expect(start).toBeTruthy();
  expect(end).toBeTruthy();

  await page.mouse.move(start!.x, start!.y);
  await page.mouse.down();
  await waitFrames(page, 2);
  await page.mouse.move(end!.x, end!.y, { steps: 24 });
  await waitFrames(page, 12);
  await page.mouse.up();
  await waitFrames(page, 24);

  const after = await snapshot(page);
  const afterTarget = after.bodies.find((body) => body.id === target!.id);
  expect(afterTarget).toBeTruthy();

  const beforeSize = bodySize(target!);
  const afterSize = bodySize(afterTarget!);
  expect(afterTarget!.center[2]).toBeGreaterThan(target!.center[2] + 0.75);
  expect(after.springs.broken).toBe(0);
  expect(afterSize.x).toBeGreaterThan(beforeSize.x * 0.7);
  expect(afterSize.x).toBeLessThan(beforeSize.x * 1.35);
  expect(afterSize.y).toBeGreaterThan(beforeSize.y * 0.7);
  expect(afterSize.y).toBeLessThan(beforeSize.y * 1.35);
  expect(afterSize.z).toBeGreaterThan(beforeSize.z * 0.7);
  expect(afterSize.z).toBeLessThan(beforeSize.z * 1.35);
  expect(after.diagnostics.maxSpherePenetration).toBeLessThan(0.2);
});
