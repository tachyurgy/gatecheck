/**
 * A runner for multi-step agent workflows in CI.
 *
 * The appeal of putting an LLM in a build pipeline is obvious: triage the flaky
 * test, draft the changelog, propose the dependency bump. The risk is equally
 * obvious once you run it a thousand times a day. A model's output is a
 * suggestion, not a result, and a pipeline that treats the two the same will
 * eventually push a plausible-looking wrong thing.
 *
 * Three rules, each of which exists because the obvious implementation gets it
 * wrong in a way that is invisible until it is expensive:
 *
 *   1. **Nothing crosses a checkpoint unvalidated.** A step's output is checked
 *      before it becomes the next step's input and before any effect runs. Not
 *      logged-and-continued. Not "warn". Blocked.
 *
 *   2. **Effects apply at most once.** Retries and replays are the entire point
 *      of a CI runner, so any effect has to be keyed and deduplicated. A step
 *      that posts a comment, cuts a release or files a ticket must not do it
 *      twice because the step after it failed and the run was restarted.
 *
 *   3. **Retries are bounded, and exhaustion escalates rather than proceeds.**
 *      The failure mode worth engineering against is not the agent erroring; it
 *      is the agent confidently returning something wrong N times and the
 *      pipeline eventually shrugging and carrying on with the last attempt.
 */

export type StepStatus =
  | "passed"
  | "rejected"
  | "escalated"
  | "skipped"
  | "effect-replayed";

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
}

export interface Validator<T> {
  name: string;
  check: (output: T, context: RunContext) => ValidationResult;
}

export interface Step<T> {
  id: string;
  description: string;
  /** The agent. Attempt number is 1-based so a producer can vary its approach. */
  produce: (context: RunContext, attempt: number) => Promise<T> | T;
  /** Checkpoints. All must pass. An empty list is rejected, not waved through. */
  validators: Validator<T>[];
  /** Total attempts allowed, including the first. */
  maxAttempts?: number;
  /**
   * The side effect. Runs only after every validator passes, and only if its
   * key has not already been applied in this run's effect log.
   */
  effect?: {
    key: (output: T, context: RunContext) => string;
    apply: (output: T, context: RunContext) => Promise<void> | void;
  };
}

export interface RunContext {
  runId: string;
  /** Outputs of steps that have passed, by step id. */
  outputs: Record<string, unknown>;
  /** Effect keys already applied. Survives a replay of the same run. */
  applied: Set<string>;
}

export interface StepReport {
  stepId: string;
  status: StepStatus;
  attempts: number;
  reasons: string[];
  effectKey?: string;
  effectApplied: boolean;
}

export interface RunReport {
  runId: string;
  completed: boolean;
  escalated: boolean;
  steps: StepReport[];
}

export class Escalation extends Error {
  constructor(
    readonly stepId: string,
    readonly attempts: number,
    readonly reasons: string[],
  ) {
    super(`step ${stepId} exhausted ${attempts} attempts: ${reasons.join("; ")}`);
    this.name = "Escalation";
  }
}

/** An effect log that outlives a single run object, so replays deduplicate. */
export class EffectLog {
  private readonly keys = new Set<string>();

  has(key: string): boolean {
    return this.keys.has(key);
  }
  record(key: string): void {
    this.keys.add(key);
  }
  get size(): number {
    return this.keys.size;
  }
  snapshot(): string[] {
    return [...this.keys].sort();
  }
}

function validate<T>(step: Step<T>, output: T, context: RunContext): ValidationResult {
  if (step.validators.length === 0) {
    // A step with no checkpoint is not "trusted", it is unreviewed. Refusing is
    // the only safe reading, and it makes the omission loud at the first run
    // rather than silent forever.
    return { ok: false, reasons: [`step ${step.id} declares no validators`] };
  }
  const reasons: string[] = [];
  for (const v of step.validators) {
    let result: ValidationResult;
    try {
      result = v.check(output, context);
    } catch (err) {
      // A validator that throws is a failed check, never a passed one.
      result = { ok: false, reasons: [`validator ${v.name} threw: ${(err as Error).message}`] };
    }
    if (!result.ok) reasons.push(...result.reasons.map((r) => `${v.name}: ${r}`));
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Run `steps` in order.
 *
 * Stops at the first step that exhausts its attempts. Later steps are reported
 * `skipped` rather than silently dropped, because a run that half-happened is
 * the thing you most need to see in a build log.
 */
export async function run<T = unknown>(
  runId: string,
  steps: Step<any>[],
  log: EffectLog = new EffectLog(),
): Promise<RunReport> {
  const context: RunContext = { runId, outputs: {}, applied: new Set(log.snapshot()) };
  const reports: StepReport[] = [];
  let halted = false;
  let escalated = false;

  for (const step of steps) {
    if (halted) {
      reports.push({ stepId: step.id, status: "skipped", attempts: 0, reasons: [], effectApplied: false });
      continue;
    }

    const maxAttempts = Math.max(1, step.maxAttempts ?? 3);
    let attempts = 0;
    let lastReasons: string[] = [];
    let accepted: unknown;
    let ok = false;

    while (attempts < maxAttempts) {
      attempts++;
      let output: unknown;
      try {
        output = await step.produce(context, attempts);
      } catch (err) {
        lastReasons = [`produce threw: ${(err as Error).message}`];
        continue;
      }
      const result = validate(step, output, context);
      if (result.ok) {
        accepted = output;
        ok = true;
        break;
      }
      lastReasons = result.reasons;
    }

    if (!ok) {
      // Exhaustion escalates. It does not fall through with the last attempt,
      // which is the failure this whole module exists to prevent.
      reports.push({
        stepId: step.id,
        status: "escalated",
        attempts,
        reasons: lastReasons,
        effectApplied: false,
      });
      halted = true;
      escalated = true;
      continue;
    }

    // Only now, past every checkpoint, may anything happen to the outside world.
    let effectKey: string | undefined;
    let effectApplied = false;
    let status: StepStatus = "passed";

    if (step.effect) {
      effectKey = step.effect.key(accepted, context);
      if (log.has(effectKey)) {
        status = "effect-replayed";
      } else {
        await step.effect.apply(accepted, context);
        log.record(effectKey);
        context.applied.add(effectKey);
        effectApplied = true;
      }
    }

    context.outputs[step.id] = accepted;
    reports.push({ stepId: step.id, status, attempts, reasons: [], effectKey, effectApplied });
  }

  return { runId, completed: !halted, escalated, steps: reports };
}

// -- validators ------------------------------------------------------------

/** Minimal structural schema check. Enough to be a real gate, small enough to read. */
export type Shape = Record<string, "string" | "number" | "boolean" | "string[]">;

export function schema<T extends Record<string, unknown>>(name: string, shape: Shape): Validator<T> {
  return {
    name,
    check(output) {
      const reasons: string[] = [];
      if (output === null || typeof output !== "object") {
        return { ok: false, reasons: ["output is not an object"] };
      }
      for (const [key, kind] of Object.entries(shape)) {
        const v = (output as Record<string, unknown>)[key];
        if (v === undefined) {
          reasons.push(`missing field ${key}`);
          continue;
        }
        const actual = Array.isArray(v) ? (v.every((x) => typeof x === "string") ? "string[]" : "array") : typeof v;
        if (actual !== kind) reasons.push(`${key} should be ${kind}, got ${actual}`);
      }
      return { ok: reasons.length === 0, reasons };
    },
  };
}

/** An arbitrary business rule, expressed as a predicate. */
export function rule<T>(name: string, message: string, predicate: (o: T, c: RunContext) => boolean): Validator<T> {
  return {
    name,
    check(output, context) {
      return predicate(output, context) ? { ok: true, reasons: [] } : { ok: false, reasons: [message] };
    },
  };
}

/**
 * A grounding check: every reference the agent cites must appear in a known set.
 *
 * The CI equivalent of a hallucinated citation is an agent blaming a test, file
 * or commit that is not in the diff it was given.
 */
export function citesOnly<T>(
  name: string,
  extract: (o: T) => string[],
  allowed: (c: RunContext) => Iterable<string>,
): Validator<T> {
  return {
    name,
    check(output, context) {
      const allow = new Set(allowed(context));
      const bad = extract(output).filter((x) => !allow.has(x));
      return bad.length === 0
        ? { ok: true, reasons: [] }
        : { ok: false, reasons: [`references not present in the run: ${bad.join(", ")}`] };
    },
  };
}
