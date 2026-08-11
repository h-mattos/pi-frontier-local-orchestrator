import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

export const DEFAULT_CONFIG = {
  planner: { provider: "openai-codex", model: "gpt-5.3-codex" },
  worker: { provider: "llama-cpp", model: "qwen2.5-coder-14b", thinking: "off" },
  maxEscalations: 1,
  workerTimeoutMs: 900000,
  debug: true,
  debugLogPath: ".pi/orchestrator-debug.log",
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

function preview(value, limit = 4000) {
  const text = String(value || "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated ${text.length - limit} characters]`;
}

function writeDebugLog(cwd, configuredPath, record) {
  const logPath = isAbsolute(configuredPath) ? configuredPath : join(cwd, configuredPath);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return logPath;
}

export function runWorker({ piCommand, cwd, model, thinking, tools, prompt, timeoutMs, signal, debug = false, debugLogPath = ".pi/orchestrator-debug.log" }) {
  const args = ["-p", "--no-session", "--model", model, "--thinking", thinking, "--tools", tools.join(","), prompt];
  return new Promise((resolve, reject) => {
    const invocation = piInvocation(args, piCommand);
    const startedAt = new Date().toISOString();
    const diagnostics = [];
    let resolvedLogPath;
    if (debug) {
      try {
        resolvedLogPath = writeDebugLog(cwd, debugLogPath, {
          event: "worker_start",
          startedAt,
          cwd,
          model,
          thinking,
          tools,
          command: invocation.command,
          args: invocation.args.map((arg, index) => index === invocation.args.length - 1 ? `<worker prompt: ${prompt.length} characters>` : arg),
          processExecPath: process.execPath,
          processArgv: process.argv.slice(0, 3)
        });
      } catch (error) {
        diagnostics.push(`Unable to write debug log: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const child = spawn(invocation.command, invocation.args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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
    child.on("error", (error) => {
      if (debug && resolvedLogPath) {
        try { writeDebugLog(cwd, debugLogPath, { event: "worker_process_error", startedAt, endedAt: new Date().toISOString(), error: error.message }); }
        catch { /* do not mask the process error */ }
      }
      finish(error);
    });
    child.on("close", (code) => {
      const result = { exitCode: code ?? 1, stderr, diagnostics, output: stdout.trim(), debugLogPath: resolvedLogPath };
      if (debug && resolvedLogPath) {
        try {
          writeDebugLog(cwd, debugLogPath, {
            event: "worker_end",
            startedAt,
            endedAt: new Date().toISOString(),
            exitCode: result.exitCode,
            stdoutBytes: Buffer.byteLength(stdout),
            stderrBytes: Buffer.byteLength(stderr),
            stdoutPreview: preview(stdout),
            stderrPreview: preview(stderr),
            diagnostics
          });
        } catch { /* logging must not change workflow behavior */ }
      }
      finish(null, result);
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
