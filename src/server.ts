/**
 * A demo pipeline you can break on purpose.
 *
 * Three steps modelled on real CI agent work: triage a flaky test, blame the
 * files responsible, then post a summary. `/api/run` takes a `mode` that
 * corrupts one step's output so you can watch a checkpoint stop it.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EffectLog,
  citesOnly,
  rule,
  run,
  schema,
  type RunContext,
  type Step,
} from "./pipeline.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = readFileSync(join(HERE, "..", "..", "public", "index.html"), "utf8");
const PORT = Number(process.env.PORT ?? 8000);

/** Files the run was actually given. Anything else is a hallucination. */
const DIFF_FILES = ["src/queue/worker.ts", "src/queue/retry.ts", "test/worker.test.ts"];

type Mode = "clean" | "bad-shape" | "bad-confidence" | "hallucinated-file" | "flaky-agent";

/** Records what the effects did, so the UI can show at-most-once behaviour. */
const effectJournal: string[] = [];

function buildSteps(mode: Mode): Step<any>[] {
  return [
    {
      id: "triage",
      description: "Identify which test is flaky and why",
      maxAttempts: 3,
      produce: (_c: RunContext, attempt: number) => {
        if (mode === "bad-shape") return { test: "test/worker.test.ts", cause: "timing" };
        if (mode === "bad-confidence")
          return { test: "test/worker.test.ts", cause: "timing", confidence: 87 };
        if (mode === "flaky-agent" && attempt < 3)
          return { test: "test/worker.test.ts", cause: "timing", confidence: 87 };
        return {
          test: "test/worker.test.ts",
          cause: "retry backoff races the fake timer",
          confidence: 0.78,
        };
      },
      validators: [
        schema("shape", { test: "string", cause: "string", confidence: "number" }),
        rule("confidence-range", "confidence must be between 0 and 1", (o: any) =>
          o.confidence >= 0 && o.confidence <= 1),
        rule("known-test", "names a test that is not in this run", (o: any) =>
          DIFF_FILES.includes(o.test)),
      ],
    },
    {
      id: "blame",
      description: "Point at the files responsible",
      maxAttempts: 3,
      produce: () =>
        mode === "hallucinated-file"
          ? { files: ["src/queue/retry.ts", "src/queue/scheduler.ts"] }
          : { files: ["src/queue/retry.ts"] },
      validators: [
        schema("shape", { files: "string[]" }),
        rule("non-empty", "must name at least one file", (o: any) => o.files.length > 0),
        citesOnly("in-diff", (o: any) => o.files, () => DIFF_FILES),
      ],
    },
    {
      id: "comment",
      description: "Post the summary to the pull request",
      maxAttempts: 2,
      produce: (c: RunContext) => {
        const t = c.outputs.triage as any;
        const b = c.outputs.blame as any;
        return {
          body: `Flaky test: ${t.test}. Likely cause: ${t.cause}. Suspect files: ${b.files.join(", ")}.`,
        };
      },
      validators: [
        schema("shape", { body: "string" }),
        rule("mentions-test", "must name the test it is about", (o: any, c) =>
          o.body.includes((c.outputs.triage as any).test)),
      ],
      effect: {
        // Keyed on the run and the content, so a replay of the same run with the
        // same finding is a no-op rather than a second comment on the PR.
        key: (o: any, c) => `pr-comment:${c.runId}:${o.body.length}`,
        apply: (o: any, c) => {
          effectJournal.push(`[${new Date().toISOString()}] posted to ${c.runId}: ${o.body}`);
        },
      },
    },
  ];
}

/** Effect log per run id, so a replay of the same id deduplicates. */
const logs = new Map<string, EffectLog>();

function json(res: import("node:http").ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  if (url.pathname === "/up") return json(res, 200, { status: "ok" });

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(INDEX);
  }

  if (url.pathname === "/api/run") {
    const mode = (url.searchParams.get("mode") ?? "clean") as Mode;
    const runId = url.searchParams.get("runId") || `run-${Date.now()}`;
    if (!logs.has(runId)) logs.set(runId, new EffectLog());
    const log = logs.get(runId)!;

    const before = effectJournal.length;
    const report = await run(runId, buildSteps(mode), log);
    return json(res, 200, {
      ...report,
      mode,
      diffFiles: DIFF_FILES,
      effectsAppliedThisCall: effectJournal.length - before,
      effectLog: log.snapshot(),
      journal: effectJournal.slice(-6),
    });
  }

  if (url.pathname === "/api/reset") {
    logs.clear();
    effectJournal.length = 0;
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(PORT, () => console.log(`gatecheck listening on ${PORT}`));
