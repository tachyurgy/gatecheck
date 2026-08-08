# Gatecheck

A runner for multi-step agent workflows in CI, where nothing crosses a checkpoint
unvalidated and no effect applies twice.

Live: **https://gatecheck.levelbrook.com**

Putting a model in a build pipeline is an easy sell: triage the flaky test, blame the
files, draft the changelog, propose the bump. The risk shows up at volume. A model's
output is a suggestion, not a result, and a pipeline that treats the two the same will
eventually push a plausible-looking wrong thing to a thousand builds a day.

Three rules, each of which exists because the obvious implementation gets it wrong in a
way that stays invisible until it is expensive.

## 1. Nothing crosses a checkpoint unvalidated

A step's output is checked before it becomes the next step's input and before any effect
runs. Not logged and continued. Not downgraded to a warning. Blocked.

Two details:

- **A step with no validators is refused, not trusted.** An unchecked step is unreviewed,
  not privileged. Refusing makes the omission loud on the first run instead of silent
  forever.
- **A validator that throws is a failed check.** Never a passed one. An exception inside a
  checkpoint is the moment you know least about the output.

Included validators are a structural `schema`, an arbitrary `rule` predicate, and
`citesOnly` — a grounding check for the CI equivalent of a hallucinated citation, where an
agent blames a file that was not in the diff it was given.

## 2. Effects apply at most once

Retries and replays are the *point* of a CI runner, so any step that touches the outside
world — posting a comment, cutting a release, filing a ticket — is keyed and deduplicated
through an effect log that outlives a single run object.

Run the same id twice on the live page and the second reports `effect-replayed`: recorded,
not repeated. Without this, re-running a pipeline that failed at step three posts the
step-two comment a second time, and the fix people reach for first — "only retry the failed
step" — is both harder and less correct than making the effect idempotent.

Retries inside a single run are covered by the same mechanism, so an agent that gets it
wrong twice and right on the third attempt still produces exactly one comment.

## 3. Exhaustion escalates, it does not proceed

The failure worth engineering against is not the agent erroring. It is the agent
confidently returning something wrong N times and the pipeline shrugging and continuing
with the last attempt.

When a step exhausts its budget the run halts, and every later step is reported `skipped`
rather than quietly dropped — a run that half-happened is exactly what you need to see in a
build log.

## Try it

The live page runs a three-step pipeline (triage → blame → comment) and lets you corrupt
one step:

- **missing field** — the shape check catches it
- **confidence 87** — right shape, wrong range; the kind of thing a schema alone waves through
- **blames a file not in the diff** — grounding check
- **agent wrong twice, right on the third** — retries work, and still only one comment

## Tests

```bash
npm install && npm test    # 17 tests
```

The two invariants were verified red before being kept. Letting an exhausted step fall
through, and removing the effect-log check, turns nine tests failing — including
`replaying a run does not apply the effect twice` and `an effect does not run when the
checkpoint fails`.

The suite runs **inside the Docker build**, so an image cannot be produced from a red suite.

## Layout

```
src/pipeline.ts   the runner, validators, effect log
src/server.ts     demo pipeline with breakable modes
test/             invariant tests
```

TypeScript, strict mode, no runtime dependencies.

## Limits

This is the harness, not an integration. The steps are simulated rather than calling a real
model, and there is no GitHub Actions adapter, no checks-API reporting, and no persistence —
the effect log is in-memory, which is fine for a demo and would need to be durable and
shared before it could deduplicate across machines. Escalation currently means halting and
reporting; a real deployment needs somewhere for a human to actually receive that, and a way
to approve and resume. Cost and latency budgets per step, which matter as much as
correctness once this runs on every commit, are not modelled.

MIT.
