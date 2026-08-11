import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

export const DEFAULT_CONFIG = {
  planner: { provider: "openai-codex", model: "gpt-5.3-codex" },
  worker: { provider: "llama-cpp", model: "qwen2.5-coder-14b", thinking: "off" },
  maxEscalations: 1,
  workerTimeoutMs: 900000,
  workerTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  escalationTriggers: ["ambiguous requirement", "architecture decision", "security-sensitive change", "repeated test failure", "context insufficient"]
};

export function mergeConfig(value = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...value,
    planner: { ...DEFAULT_CONFIG.planner, ...(value.planner || {}) },
    worker: { ...DEFAULT_CONFIG.worker, ...(value.worker || {}) },
    workerTools: value.workerTools || DEFAULT_CONFIG.workerTools,
    escalationTriggers: value.escalationTriggers || DEFAULT_CONFIG.escalationTriggers
  };
}

export function modelRef(model) {
  return `${model.provider}/${model.model}`;
}

export function parseOrchestrateArgs(input) {
  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) || [];
  const overrides = {};
  const goal = [];
  for (let i = 0; i < tokens.length; i++) {
    if ((tokens[i] === "--planner" || tokens[i] === "--worker") && tokens[i + 1]) {
      const role = tokens[i].slice(2);
      const ref = tokens[++i];
      const slash = ref.indexOf("/");
      if (slash < 1 || slash === ref.length - 1) throw new Error(`${tokens[i - 1]} must be provider/model`);
      overrides[role] = { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
    } else {
      goal.push(tokens[i]);
    }
  }
  return { goal: goal.join(" ").trim(), ...overrides };
}

export function shouldPromptForModels({ parsed, sessionModels, hasProjectConfig }) {
  return !parsed.planner && !parsed.worker && !sessionModels.planner && !sessionModels.worker && !hasProjectConfig;
}

export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate) throw new Error("Model did not return a JSON object");
  return JSON.parse(candidate);
}

export function validatePlan(plan) {
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error("Plan must contain at least one task");
  for (const [i, task] of plan.tasks.entries()) {
    if (!task.id || !task.title || !task.instructions || !Array.isArray(task.acceptanceCriteria)) {
      throw new Error(`Invalid plan task at index ${i}`);
    }
  }
  return plan;
}

export function finalAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role && message.role !== "assistant") continue;
    if (typeof message?.response === "string" && message.response.trim()) return message.response;
    if (typeof message?.content === "string" && message.content.trim()) return message.content;
    if (!Array.isArray(message?.content)) continue;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
    if (text) return text;
  }
  return "";
}

export function piInvocation(args, explicitCommand) {
  if (explicitCommand) return { command: explicitCommand, args };
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

export function workerFailureSummary(result) {
  return result.output?.trim()
    || result.stderr?.trim()
    || result.diagnostics?.join("\n").trim()
    || `Worker exited with code ${result.exitCode} without producing a report`;
}

export function runWorker({ piCommand, cwd, model, thinking, tools, prompt, timeoutMs, signal }) {
  const args = ["-p", "--no-session", "--model", model, "--thinking", thinking, "--tools", tools.join(","), prompt];
  return new Promise((resolve, reject) => {
    const invocation = piInvocation(args, piCommand);
    const child = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const diagnostics = [];
    let stderr = "";
    let stdout = "";
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      finish(null, { exitCode: code ?? 1, stderr, diagnostics, output: stdout.trim() });
    });
    const abort = () => child.kill("SIGTERM");
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`Worker timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
}
