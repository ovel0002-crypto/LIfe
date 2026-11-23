import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createServices } from "../src/app";
import { prefilter, senderOf } from "../src/agent/triage";
import { openDb } from "../src/db";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");
const email = (n: string) => {
  const body = fx(n);
  return { title: body.match(/^Subject: (.*)$/m)?.[1] ?? "", body };
};

describe("email importance prefilter", () => {
  it("keeps payments and bookings even from no-reply senders", () => {
    expect(prefilter(email("email-afterpay.txt"))).toBe(true);
    expect(prefilter(email("email-agl.txt"))).toBe(true);
    expect(prefilter(email("email-vicroads.txt"))).toBe(true);
  });

  it("drops marketing", () => {
    expect(prefilter(email("email-noise.txt"))).toBe(false);
  });

  it("reads the sender and honours learned ignores", () => {
    expect(senderOf(fx("email-afterpay.txt"))).toBe("donotreply@afterpay.com");
    expect(prefilter(email("email-afterpay.txt"), ["donotreply@afterpay.com"])).toBe(false);
  });

  it("learns to ignore a sender after two rejections with no accepts", async () => {
    const s = createServices(await openDb({ memory: true }));
    for (const b of ["b1", "b2"]) {
      await s.store.setKv(`batchSender:${b}`, "deals@shop.example");
      const c = await s.store.create("task", { id: `t_${b}`, title: "Buy socks", area: "admin", status: "todo", estimateMinutes: 5, source: "gmail", createdAt: new Date().toISOString() }, { actor: "connector", batchId: b, propose: true });
      await s.store.reject(c.id);
    }
    expect(await s.store.getKv<string[]>("ignoredSenders")).toEqual(["deals@shop.example"]);
  });
});
