import { spawn } from "node:child_process";

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

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text" && typeof part.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function finalAssistantText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const text = contentText(message.content || message.text || message.response);
    if (text) return text;
  }
  return "";
}

function textFromJsonEvent(event) {
  if (event?.message) return contentText(event.message.content || event.message.text || event.message.response);
  return contentText(event?.content || event?.text || event?.response || event?.delta);
}

export function runWorker({ piCommand = "pi", cwd, model, thinking, tools, prompt, timeoutMs, signal }) {
  const args = ["--mode", "json", "-p", "--no-session", "--model", model, "--thinking", thinking, "--tools", tools.join(","), prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(piCommand, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const messages = [];
    const eventTexts = [];
    let stderr = "";
    let stdout = "";
    let buffer = "";
    let settled = false;
    let timer;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      error ? reject(error) : resolve(result);
    };
    const parseLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (event.message?.role === "assistant") messages.push(event.message);
        if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) messages.push(event.message);
        const text = textFromJsonEvent(event);
        if (text) eventTexts.push(text);
      } catch { /* ignore non-JSON diagnostics */ }
    };
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(parseLine);
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      parseLine(buffer);
      finish(null, { exitCode: code ?? 1, messages, stderr, stdout, output: finalAssistantText(messages) || eventTexts.join("\n") || stdout });
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
