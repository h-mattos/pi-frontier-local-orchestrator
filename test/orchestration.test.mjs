import test from "node:test";
import assert from "node:assert/strict";
import { extractJson, finalAssistantText, mergeConfig, modelRef, parseOrchestrateArgs, shouldPromptForModels, validatePlan } from "../extensions/lib/orchestration.js";

test("merges nested configuration", () => {
  const config = mergeConfig({ worker: { model: "local-model" }, maxEscalations: 2 });
  assert.equal(config.worker.provider, "llama-cpp");
  assert.equal(config.worker.model, "local-model");
  assert.equal(config.maxEscalations, 2);
});
test("extracts fenced JSON", () => assert.deepEqual(extractJson("ok\n```json\n{\"x\":1}\n```"), { x: 1 }));
test("validates structured plan", () => assert.equal(validatePlan({ tasks: [{ id: "T1", title: "x", instructions: "y", acceptanceCriteria: [] }] }).tasks.length, 1));
test("rejects malformed plan", () => assert.throws(() => validatePlan({ tasks: [] })));
test("formats model references", () => assert.equal(modelRef({ provider: "p", model: "m" }), "p/m"));
test("finds last assistant text", () => assert.equal(finalAssistantText([{ role: "assistant", content: [{ type: "text", text: "done" }] }]), "done"));
test("parses per-run model overrides", () => {
  assert.deepEqual(parseOrchestrateArgs('--planner openai/gpt-5 --worker local/qwen "fix the tests"'), {
    goal: "fix the tests",
    planner: { provider: "openai", model: "gpt-5" },
    worker: { provider: "local", model: "qwen" }
  });
});
test("allows model ids containing slashes", () => assert.equal(parseOrchestrateArgs("--worker openrouter/org/model do it").worker.model, "org/model"));
test("prompts only when no model source is present", () => {
  assert.equal(shouldPromptForModels({ parsed: {}, sessionModels: {}, hasProjectConfig: false }), true);
  assert.equal(shouldPromptForModels({ parsed: {}, sessionModels: {}, hasProjectConfig: true }), false);
  assert.equal(shouldPromptForModels({ parsed: { planner: { provider: "p", model: "m" } }, sessionModels: {}, hasProjectConfig: false }), false);
});
