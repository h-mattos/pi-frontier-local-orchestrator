import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extractJson, mergeConfig, modelRef, parseOrchestrateArgs, runWorker, shouldPromptForModels, validatePlan, workerFailureSummary } from "./lib/orchestration.js";

const PLAN_SYSTEM = `You are the Planner in a two-model coding workflow. Return JSON only: {"summary":"...","tasks":[{"id":"T1","title":"...","instructions":"...","acceptanceCriteria":["..."],"risk":"low|medium|high"}]}. Create small sequential tasks with decisive instructions for the Worker. Keep ambiguous architecture, security decisions, and difficult reasoning in the Planner role.`;
const REVIEW_SYSTEM = `You are the Planner performing final review. Review the original goal, plan, and compact Worker reports. Return concise Markdown with: verdict (PASS or NEEDS_WORK), verified outcomes, remaining risks, and exact next actions. Do not claim checks not shown in the reports.`;

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

async function loadConfig(cwd: string) {
  try {
    return {
      config: mergeConfig(JSON.parse(await readFile(join(cwd, ".pi", "orchestrator.json"), "utf8"))),
      hasProjectConfig: true
    };
  }
  catch (error: any) {
    if (error?.code === "ENOENT") return { config: mergeConfig(), hasProjectConfig: false };
    throw new Error(`Invalid .pi/orchestrator.json: ${error.message}`);
  }
}

function workerPrompt(goal: string, task: any, triggers: string[]) {
  return `You are the local executor. Work only on this task in the current repository.\n\nOverall goal: ${goal}\nTask ${task.id}: ${task.title}\nInstructions: ${task.instructions}\nAcceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}\n\nUse repository tools, make changes, and run relevant checks. If blocked or if any escalation trigger applies (${triggers.join(", ")}), stop before guessing. End with exactly one compact JSON report in a fenced json block: {"taskId":"${task.id}","status":"completed|escalate|failed","summary":"...","filesChanged":["..."],"checks":[{"command":"...","result":"pass|fail|not_run"}],"escalationReason":""}.`;
}

type Activity = {
  actor: "planner" | "worker" | "system";
  state: "running" | "completed" | "escalated" | "failed";
  title: string;
  detail?: string;
};

function activityLine(activity: Activity, theme: any) {
  const actor = activity.actor === "planner" ? "PLANNER" : activity.actor === "worker" ? "WORKER" : "ORCHESTRATOR";
  const actorColor = activity.actor === "planner" ? "accent" : activity.actor === "worker" ? "toolTitle" : "muted";
  const icon = activity.state === "completed" ? "✓" : activity.state === "escalated" ? "↑" : activity.state === "failed" ? "✗" : "●";
  const stateColor = activity.state === "completed" ? "success" : activity.state === "escalated" ? "warning" : activity.state === "failed" ? "error" : "accent";
  let line = `${theme.fg(stateColor, icon)} ${theme.bold(theme.fg(actorColor, actor))}  ${activity.title}`;
  if (activity.detail) line += `\n   ${theme.fg("dim", activity.detail)}`;
  return line;
}

export default function (pi: ExtensionAPI) {
  let sessionModels: { planner?: { provider: string; model: string }; worker?: { provider: string; model: string } } = {};
  const chooseModels = async (ctx: any) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Choose models with --planner and --worker, or add .pi/orchestrator.json", "error");
      return false;
    }
    const models = ctx.modelRegistry.getAvailable();
    if (models.length === 0) {
      ctx.ui.notify("No available models. Configure or log in to a provider first.", "error");
      return false;
    }
    const refs = models.map((model: any) => `${model.provider}/${model.id}`);
    const plannerRef = await ctx.ui.select("Choose the Planner model", refs);
    if (!plannerRef) return false;
    const workerRef = await ctx.ui.select("Choose the Worker model", refs);
    if (!workerRef) return false;
    const split = (ref: string) => {
      const slash = ref.indexOf("/");
      return { provider: ref.slice(0, slash), model: ref.slice(slash + 1) };
    };
    sessionModels = { planner: split(plannerRef), worker: split(workerRef) };
    ctx.ui.notify(`Planner: ${plannerRef}\nWorker: ${workerRef}`, "info");
    return true;
  };
  const logActivity = (activity: Activity) => pi.appendEntry("orchestrator-activity", activity);
  pi.registerEntryRenderer("orchestrator-activity", (entry, _options, theme) =>
    new Text(activityLine(entry.data as Activity, theme), 1, 0)
  );
  pi.registerMessageRenderer("orchestrator-result", (message, _options, theme) => {
    const passed = /\bPASS\b/i.test(message.content) && !/\bNEEDS_WORK\b/i.test(message.content);
    const heading = theme.bold(theme.fg(passed ? "success" : "warning", passed ? "✓ PLANNER REVIEW: PASS" : "! PLANNER REVIEW: NEEDS WORK"));
    return new Text(`${heading}\n\n${message.content}`, 1, 0);
  });
  pi.registerCommand("orchestrate-models", {
    description: "Choose any available Planner and Worker models for this session",
    handler: async (_args, ctx) => {
      await chooseModels(ctx);
    }
  });
  pi.registerCommand("orchestrate", {
    description: "Plan with one model, execute with another, then review",
    handler: async (args, ctx) => {
      let parsed;
      try { parsed = parseOrchestrateArgs(args); }
      catch (error: any) { return ctx.ui.notify(error.message, "error"); }
      const goal = parsed.goal;
      if (!goal) return ctx.ui.notify("Usage: /orchestrate [--planner provider/model] [--worker provider/model] <goal>", "error");
      const loaded = await loadConfig(ctx.cwd);
      if (shouldPromptForModels({ parsed, sessionModels, hasProjectConfig: loaded.hasProjectConfig })) {
        const selected = await chooseModels(ctx);
        if (!selected) return;
      }
      const fileConfig = loaded.config;
      const config = {
        ...fileConfig,
        planner: { ...fileConfig.planner, ...sessionModels.planner, ...parsed.planner },
        worker: { ...fileConfig.worker, ...sessionModels.worker, ...parsed.worker }
      };
      const planner = ctx.modelRegistry.find(config.planner.provider, config.planner.model);
      if (!planner) return ctx.ui.notify(`Planner model not found: ${modelRef(config.planner)}`, "error");
      const worker = ctx.modelRegistry.find(config.worker.provider, config.worker.model);
      if (!worker) return ctx.ui.notify(`Worker model not found: ${modelRef(config.worker)}`, "error");
      ctx.ui.setStatus("orchestrator", "Planner working…");
      logActivity({ actor: "planner", state: "running", title: "Planning the work", detail: modelRef(config.planner) });
      try {
        const planResponse = await ctx.modelRegistry.complete(planner, { systemPrompt: PLAN_SYSTEM, messages: [userMessage(goal)] }, { signal: ctx.signal, cacheRetention: "none" });
        const planText = planResponse.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        const plan = validatePlan(extractJson(planText));
        logActivity({
          actor: "planner",
          state: "completed",
          title: `Created ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}`,
          detail: plan.tasks.map((task: any, index: number) => `${index + 1}. ${task.title}`).join("  •  ")
        });
        const reports = [];
        for (const [index, task] of plan.tasks.entries()) {
          ctx.ui.setStatus("orchestrator", `Local worker ${index + 1}/${plan.tasks.length}: ${task.title}`);
          logActivity({ actor: "worker", state: "running", title: `Task ${index + 1}/${plan.tasks.length}: ${task.title}`, detail: modelRef(config.worker) });
          let result = await runWorker({ cwd: ctx.cwd, model: modelRef(config.worker), thinking: config.worker.thinking, tools: config.workerTools, prompt: workerPrompt(goal, task, config.escalationTriggers), timeoutMs: config.workerTimeoutMs, signal: ctx.signal });
          let report: any;
          try { report = extractJson(result.output); }
          catch {
            const failure = workerFailureSummary(result);
            report = {
              taskId: task.id,
              status: config.maxEscalations > 0 ? "escalate" : "failed",
              summary: failure,
              filesChanged: [],
              checks: [],
              escalationReason: `Worker did not return a valid report. ${failure}`
            };
          }
          if (report.status === "escalate" && config.maxEscalations > 0) {
            ctx.ui.setStatus("orchestrator", `Planner escalation: ${task.title}`);
            logActivity({ actor: "worker", state: "escalated", title: `Asked Planner for help: ${task.title}`, detail: report.escalationReason || report.summary });
            logActivity({ actor: "planner", state: "running", title: "Resolving Worker escalation", detail: modelRef(config.planner) });
            const escalation = await ctx.modelRegistry.complete(planner, { systemPrompt: PLAN_SYSTEM, messages: [userMessage(`Goal: ${goal}\nTask: ${JSON.stringify(task)}\nWorker escalation: ${JSON.stringify(report)}\nReturn JSON only: {"instructions":"revised, decisive instructions for one retry"}`)] }, { signal: ctx.signal, cacheRetention: "none" });
            const text = escalation.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
            const revised = extractJson(text);
            logActivity({ actor: "planner", state: "completed", title: "Returned revised instructions to Worker" });
            logActivity({ actor: "worker", state: "running", title: `Retrying: ${task.title}`, detail: modelRef(config.worker) });
            result = await runWorker({ cwd: ctx.cwd, model: modelRef(config.worker), thinking: config.worker.thinking, tools: config.workerTools, prompt: workerPrompt(goal, { ...task, instructions: revised.instructions }, config.escalationTriggers), timeoutMs: config.workerTimeoutMs, signal: ctx.signal });
            try { report = extractJson(result.output); }
            catch { report = { ...report, status: "failed", summary: workerFailureSummary(result) }; }
          }
          reports.push(report);
          const files = Array.isArray(report.filesChanged) ? report.filesChanged.length : 0;
          const checks = Array.isArray(report.checks) ? report.checks.filter((check: any) => check.result === "pass").length : 0;
          logActivity({
            actor: "worker",
            state: report.status === "completed" ? "completed" : "failed",
            title: `${report.status === "completed" ? "Finished" : "Stopped"}: ${task.title}`,
            detail: `${report.summary || "No summary"} (${files} file${files === 1 ? "" : "s"} changed, ${checks} check${checks === 1 ? "" : "s"} passed)`
          });
          if (report.status !== "completed") break;
        }
        ctx.ui.setStatus("orchestrator", "Planner final review…");
        logActivity({ actor: "planner", state: "running", title: "Reviewing the Worker’s evidence", detail: modelRef(config.planner) });
        const review = await ctx.modelRegistry.complete(planner, { systemPrompt: REVIEW_SYSTEM, messages: [userMessage(`Original goal:\n${goal}\n\nPlan:\n${JSON.stringify(plan)}\n\nWorker reports:\n${JSON.stringify(reports)}`)] }, { signal: ctx.signal, cacheRetention: "none" });
        const reviewText = review.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        logActivity({ actor: "planner", state: "completed", title: "Final review complete" });
        pi.sendMessage({ customType: "orchestrator-result", content: `## Orchestration complete\n\n${reviewText}`, display: true, details: { plan, reports } });
      } catch (error: any) {
        logActivity({ actor: "system", state: "failed", title: "Workflow stopped", detail: error.message });
        ctx.ui.notify(`Orchestration failed: ${error.message}`, "error");
      } finally {
        ctx.ui.setStatus("orchestrator", undefined);
      }
    }
  });
}
