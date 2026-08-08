import assert from "node:assert/strict";
import test from "node:test";

import {
  EffectLog,
  citesOnly,
  rule,
  run,
  schema,
  type RunContext,
  type Step,
} from "../src/pipeline.js";

const triageShape = { test: "string", cause: "string", confidence: "number" } as const;

function triageStep(
  produce: Step<any>["produce"],
  extra: Partial<Step<any>> = {},
): Step<any> {
  return {
    id: "triage",
    description: "identify the flaky test",
    produce,
    validators: [
      schema("shape", { ...triageShape }),
      rule("confidence", "confidence must be between 0 and 1", (o: any) => o.confidence >= 0 && o.confidence <= 1),
    ],
    ...extra,
  };
}

// -- checkpoints block ----------------------------------------------------

test("a well formed output passes", async () => {
  const r = await run("run-1", [
    triageStep(() => ({ test: "a_spec.ts", cause: "timing", confidence: 0.8 })),
  ]);
  assert.equal(r.completed, true);
  assert.equal(r.steps[0].status, "passed");
  assert.equal(r.steps[0].attempts, 1);
});

test("a malformed output never passes, however many times it is produced", async () => {
  const r = await run("run-2", [
    triageStep(() => ({ test: "a_spec.ts", cause: "timing" })), // confidence missing
  ]);
  assert.equal(r.completed, false);
  assert.equal(r.steps[0].status, "escalated");
  assert.equal(r.steps[0].attempts, 3);
  assert.ok(r.steps[0].reasons.some((x) => x.includes("missing field confidence")));
});

test("an out of range value is rejected even though the shape is right", async () => {
  const r = await run("run-3", [
    triageStep(() => ({ test: "a.ts", cause: "timing", confidence: 4.2 })),
  ]);
  assert.equal(r.steps[0].status, "escalated");
  assert.ok(r.steps[0].reasons.some((x) => x.includes("between 0 and 1")));
});

test("a step with no validators is refused rather than trusted", async () => {
  const r = await run("run-4", [
    { id: "s", description: "", produce: () => ({ anything: true }), validators: [] },
  ]);
  assert.equal(r.steps[0].status, "escalated");
  assert.ok(r.steps[0].reasons.some((x) => x.includes("declares no validators")));
});

test("a validator that throws counts as a failed check", async () => {
  const r = await run("run-5", [
    {
      id: "s",
      description: "",
      produce: () => ({ ok: true }),
      validators: [{ name: "boom", check: () => { throw new Error("kaboom"); } }],
    },
  ]);
  assert.equal(r.steps[0].status, "escalated");
  assert.ok(r.steps[0].reasons.some((x) => x.includes("threw: kaboom")));
});

test("a producer that throws is retried, not fatal", async () => {
  let n = 0;
  const r = await run("run-6", [
    triageStep(() => {
      n++;
      if (n < 3) throw new Error("model timeout");
      return { test: "a.ts", cause: "timing", confidence: 0.5 };
    }),
  ]);
  assert.equal(r.steps[0].status, "passed");
  assert.equal(r.steps[0].attempts, 3);
});

test("retries stop at the configured budget", async () => {
  let calls = 0;
  const r = await run("run-7", [
    triageStep(() => { calls++; return { nope: true }; }, { maxAttempts: 5 }),
  ]);
  assert.equal(calls, 5);
  assert.equal(r.steps[0].attempts, 5);
  assert.equal(r.steps[0].status, "escalated");
});

test("a later attempt can succeed and is the one accepted", async () => {
  const r = await run("run-8", [
    triageStep((_c, attempt) =>
      attempt < 2
        ? { test: "a.ts", cause: "timing", confidence: 99 }
        : { test: "a.ts", cause: "timing", confidence: 0.42 },
    ),
  ]);
  assert.equal(r.steps[0].status, "passed");
});

// -- effects --------------------------------------------------------------

test("an effect does not run when the checkpoint fails", async () => {
  let applied = 0;
  await run("run-9", [
    triageStep(() => ({ bad: true }), {
      effect: { key: () => "k", apply: () => { applied++; } },
    }),
  ]);
  assert.equal(applied, 0, "an effect ran on unvalidated output");
});

test("an effect runs once when the checkpoint passes", async () => {
  let applied = 0;
  const r = await run("run-10", [
    triageStep(() => ({ test: "a.ts", cause: "timing", confidence: 0.5 }), {
      effect: { key: (o: any) => `comment:${o.test}`, apply: () => { applied++; } },
    }),
  ]);
  assert.equal(applied, 1);
  assert.equal(r.steps[0].effectApplied, true);
  assert.equal(r.steps[0].effectKey, "comment:a.ts");
});

test("replaying a run does not apply the effect twice", async () => {
  // THE invariant. A shared effect log is what makes a re-run safe, and this is
  // what fails if the log check is removed.
  let applied = 0;
  const log = new EffectLog();
  const steps = () => [
    triageStep(() => ({ test: "a.ts", cause: "timing", confidence: 0.5 }), {
      effect: { key: (o: any) => `comment:${o.test}`, apply: () => { applied++; } },
    }),
  ];

  const first = await run("run-11", steps(), log);
  const second = await run("run-11", steps(), log);

  assert.equal(applied, 1, "effect applied twice across a replay");
  assert.equal(first.steps[0].status, "passed");
  assert.equal(second.steps[0].status, "effect-replayed");
  assert.equal(second.steps[0].effectApplied, false);
});

test("a retry inside one run does not apply the effect more than once", async () => {
  let applied = 0;
  const r = await run("run-12", [
    triageStep((_c, attempt) =>
      attempt < 3
        ? { test: "a.ts", cause: "timing", confidence: 50 }
        : { test: "a.ts", cause: "timing", confidence: 0.5 },
      { effect: { key: () => "once", apply: () => { applied++; } } },
    ),
  ]);
  assert.equal(applied, 1);
  assert.equal(r.steps[0].attempts, 3);
});

test("distinct outputs produce distinct effect keys", async () => {
  let applied = 0;
  const log = new EffectLog();
  const mk = (name: string) => [
    triageStep(() => ({ test: name, cause: "timing", confidence: 0.5 }), {
      effect: { key: (o: any) => `comment:${o.test}`, apply: () => { applied++; } },
    }),
  ];
  await run("r", mk("a.ts"), log);
  await run("r", mk("b.ts"), log);
  assert.equal(applied, 2);
  assert.deepEqual(log.snapshot(), ["comment:a.ts", "comment:b.ts"]);
});

// -- halting --------------------------------------------------------------

test("escalation halts the run and later steps are reported skipped", async () => {
  let reached = false;
  const r = await run("run-13", [
    triageStep(() => ({ bad: true })),
    {
      id: "post",
      description: "post the summary",
      produce: () => { reached = true; return { ok: true }; },
      validators: [rule("always", "", () => true)],
    },
  ]);
  assert.equal(reached, false, "a step ran after an escalation");
  assert.equal(r.escalated, true);
  assert.equal(r.completed, false);
  assert.equal(r.steps[1].status, "skipped");
});

test("a passing run makes earlier outputs available to later steps", async () => {
  const r = await run("run-14", [
    triageStep(() => ({ test: "a.ts", cause: "timing", confidence: 0.5 })),
    {
      id: "summarise",
      description: "",
      produce: (c: RunContext) => ({ text: `flaky: ${(c.outputs.triage as any).test}` }),
      validators: [rule("mentions", "must name the test", (o: any) => o.text.includes("a.ts"))],
    },
  ]);
  assert.equal(r.completed, true);
  assert.equal(r.steps[1].status, "passed");
});

// -- grounding ------------------------------------------------------------

test("citing a file that is not in the diff is rejected", async () => {
  const r = await run("run-15", [
    {
      id: "blame",
      description: "",
      produce: () => ({ files: ["src/real.ts", "src/imagined.ts"] }),
      validators: [
        citesOnly("in-diff", (o: any) => o.files, () => ["src/real.ts", "src/other.ts"]),
      ],
    },
  ]);
  assert.equal(r.steps[0].status, "escalated");
  assert.ok(r.steps[0].reasons.some((x) => x.includes("src/imagined.ts")));
});

test("citing only files in the diff passes", async () => {
  const r = await run("run-16", [
    {
      id: "blame",
      description: "",
      produce: () => ({ files: ["src/real.ts"] }),
      validators: [citesOnly("in-diff", (o: any) => o.files, () => ["src/real.ts"])],
    },
  ]);
  assert.equal(r.steps[0].status, "passed");
});
