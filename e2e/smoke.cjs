/**
 * End-to-end smoke test against a running server with demo data:
 *   LIFE_DATA_DIR=./data-demo pnpm --filter @life/server seed
 *   LIFE_APP_DIR=../app/dist LIFE_DATA_DIR=./data-demo pnpm dev:server
 *   node e2e/smoke.cjs http://localhost:8787
 */
const { chromium, devices } = require("playwright");
const assert = (c, m) => { if (!c) { throw new Error("FAIL: " + m); } console.log("ok -", m); };

(async () => {
  const base = process.argv[2] ?? "http://localhost:8787";
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ ...devices["iPhone 15"] })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(base + "/", { waitUntil: "networkidle" });
    assert(await page.getByText("Must do").isVisible(), "Today list renders sections");

    const today = await (await page.request.get(base + "/api/today")).json();
    const target = today.could.find((i) => i.kind === "task");
    assert(target, "there is a quick task to complete");
    const row = page.getByText(target.title).first();
    await row.scrollIntoViewIfNeeded();
    const circle = page.getByLabel("Mark done");
    // Click the circle in the same row as the target title.
    const box = await row.boundingBox();
    const circles = await circle.all();
    let clicked = false;
    for (const c of circles) {
      const b = await c.boundingBox();
      if (b && Math.abs(b.y - box.y) < 40) { await c.click(); clicked = true; break; }
    }
    assert(clicked, "found the done circle for the task");
    await page.getByText(`Done: ${target.title}`).waitFor({ timeout: 5000 });
    assert(true, "toast confirms done");
    const after = await (await page.request.get(base + "/api/tasks")).json();
    assert(after.find((t) => t.id === target.taskId).status === "done", "task is done on the server");

    await page.getByText("Undo", { exact: true }).click();
    await page.waitForTimeout(800);
    const undone = await (await page.request.get(base + "/api/tasks")).json();
    assert(undone.find((t) => t.id === target.taskId).status === "todo", "undo restores the task");

    await page.getByText("Low energy").first().click();
    await page.waitForTimeout(800);
    const plan = await (await page.request.get(base + "/api/plan")).json();
    assert(plan.days[0].mode === "low-energy", "day mode re-flows the plan");
    await page.getByText("Normal").first().click();
    await page.waitForTimeout(500);

    await page.goto(base + "/review", { waitUntil: "networkidle" });
    assert(await page.getByText("Screenshots").first().isVisible(), "weekly review opens");
    assert(errors.length === 0, "no page errors " + JSON.stringify(errors));
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
