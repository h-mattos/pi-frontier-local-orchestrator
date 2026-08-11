import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { extractJson, mergeConfig, modelRef, runWorker, validatePlan } from "./lib/orchestration.js";

const PLAN_SYSTEM = `You are the frontier planner in a two-tier coding workflow. Return JSON only: {"summary":"...","tasks":[{"id":"T1","title":"...","instructions":"...","acceptanceCriteria":["..."],"risk":"low|medium|high"}]}. Create small sequential tasks for a less capable worker. Reserve ambiguous architecture, security decisions, and hard reasoning for yourself.`;
const REVIEW_SYSTEM = `You are the frontier final reviewer. Review the original goal, plan, and compact worker reports. Return concise Markdown with: verdict (PASS or NEEDS_WORK), verified outcomes, remaining risks, and exact next actions. Do not claim checks not shown in the reports.`;

function userMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

async function loadConfig(cwd: string) {
  try { return mergeConfig(JSON.parse(await readFile(join(cwd, ".pi", "orchestrator.json"), "utf8"))); }
  catch (error: any) {
    if (error?.code === "ENOENT") return mergeConfig();
    throw new Error(`Invalid .pi/orchestrator.json: ${error.message}`);
  }
}

function workerPrompt(goal: string, task: any, triggers: string[]) {
  return `You are the local executor. Work only on this task in the current repository.\n\nOverall goal: ${goal}\nTask ${task.id}: ${task.title}\nInstructions: ${task.instructions}\nAcceptance criteria:\n- ${task.acceptanceCriteria.join("\n- ")}\n\nUse repository tools, make changes, and run relevant checks. If blocked or if any escalation trigger applies (${triggers.join(", ")}), stop before guessing. End with exactly one compact JSON report in a fenced json block: {"taskId":"${task.id}","status":"completed|escalate|failed","summary":"...","filesChanged":["..."],"checks":[{"command":"...","result":"pass|fail|not_run"}],"escalationReason":""}.`;
}

type Activity = {
  actor: "frontier" | "local" | "system";
  state: "running" | "completed" | "escalated" | "failed";
  title: string;
  detail?: string;
};

function activityLine(activity: Activity, theme: any) {
  const actor = activity.actor === "frontier" ? "FRONTIER" : activity.actor === "local" ? "LOCAL" : "ORCHESTRATOR";
  const actorColor = activity.actor === "frontier" ? "accent" : activity.actor === "local" ? "toolTitle" : "muted";
  const icon = activity.state === "completed" ? "✓" : activity.state === "escalated" ? "↑" : activity.state === "failed" ? "✗" : "●";
  const stateColor = activity.state === "completed" ? "success" : activity.state === "escalated" ? "warning" : activity.state === "failed" ? "error" : "accent";
  let line = `${theme.fg(stateColor, icon)} ${theme.bold(theme.fg(actorColor, actor))}  ${activity.title}`;
  if (activity.detail) line += `\n   ${theme.fg("dim", activity.detail)}`;
  return line;
}

export default function (pi: ExtensionAPI) {
  const logActivity = (activity: Activity) => pi.appendEntry("orchestrator-activity", activity);
  pi.registerEntryRenderer("orchestrator-activity", (entry, _options, theme) =>
    new Text(activityLine(entry.data as Activity, theme), 1, 0)
  );
  pi.registerMessageRenderer("orchestrator-result", (message, _options, theme) => {
    const passed = /\bPASS\b/i.test(message.content) && !/\bNEEDS_WORK\b/i.test(message.content);
    const heading = theme.bold(theme.fg(passed ? "success" : "warning", passed ? "✓ FRONTIER REVIEW: PASS" : "! FRONTIER REVIEW: NEEDS WORK"));
    return new Text(`${heading}\n\n${message.content}`, 1, 0);
  });
  pi.registerCommand("orchestrate", {
    description: "Plan with a frontier model, execute locally, then frontier-review",
    handler: async (args, ctx) => {
      const goal = args.trim();
      if (!goal) return ctx.ui.notify("Usage: /orchestrate <goal>", "error");
      const config = await loadConfig(ctx.cwd);
      const planner = ctx.modelRegistry.find(config.planner.provider, config.planner.model);
      if (!planner) return ctx.ui.notify(`Planner model not found: ${modelRef(config.planner)}`, "error");
      ctx.ui.setStatus("orchestrator", "Frontier planning…");
      logActivity({ actor: "frontier", state: "running", title: "Planning the work", detail: modelRef(config.planner) });
      try {
        const planResponse = await ctx.modelRegistry.complete(planner, { systemPrompt: PLAN_SYSTEM, messages: [userMessage(goal)] }, { signal: ctx.signal, cacheRetention: "none" });
        const planText = planResponse.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        const plan = validatePlan(extractJson(planText));
        logActivity({
          actor: "frontier",
          state: "completed",
          title: `Created ${plan.tasks.length} task${plan.tasks.length === 1 ? "" : "s"}`,
          detail: plan.tasks.map((task: any, index: number) => `${index + 1}. ${task.title}`).join("  •  ")
        });
        const reports = [];
        for (const [index, task] of plan.tasks.entries()) {
          ctx.ui.setStatus("orchestrator", `Local worker ${index + 1}/${plan.tasks.length}: ${task.title}`);
          logActivity({ actor: "local", state: "running", title: `Task ${index + 1}/${plan.tasks.length}: ${task.title}`, detail: modelRef(config.worker) });
          let result = await runWorker({ cwd: ctx.cwd, model: modelRef(config.worker), thinking: config.worker.thinking, tools: config.workerTools, prompt: workerPrompt(goal, task, config.escalationTriggers), timeoutMs: config.workerTimeoutMs, signal: ctx.signal });
          let report: any;
          try { report = extractJson(result.output); } catch { report = { taskId: task.id, status: result.exitCode === 0 ? "failed" : "failed", summary: result.output || result.stderr, filesChanged: [], checks: [], escalationReason: "Worker did not return a valid report" }; }
          if (report.status === "escalate" && config.maxEscalations > 0) {
            ctx.ui.setStatus("orchestrator", `Frontier escalation: ${task.title}`);
            logActivity({ actor: "local", state: "escalated", title: `Asked Frontier for help: ${task.title}`, detail: report.escalationReason || report.summary });
            logActivity({ actor: "frontier", state: "running", title: "Resolving worker escalation", detail: modelRef(config.planner) });
            const escalation = await ctx.modelRegistry.complete(planner, { systemPrompt: PLAN_SYSTEM, messages: [userMessage(`Goal: ${goal}\nTask: ${JSON.stringify(task)}\nWorker escalation: ${JSON.stringify(report)}\nReturn JSON only: {"instructions":"revised, decisive instructions for one retry"}`)] }, { signal: ctx.signal, cacheRetention: "none" });
            const text = escalation.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
            const revised = extractJson(text);
            logActivity({ actor: "frontier", state: "completed", title: "Returned revised instructions to Local Worker" });
            logActivity({ actor: "local", state: "running", title: `Retrying: ${task.title}`, detail: modelRef(config.worker) });
            result = await runWorker({ cwd: ctx.cwd, model: modelRef(config.worker), thinking: config.worker.thinking, tools: config.workerTools, prompt: workerPrompt(goal, { ...task, instructions: revised.instructions }, config.escalationTriggers), timeoutMs: config.workerTimeoutMs, signal: ctx.signal });
            try { report = extractJson(result.output); } catch { report = { ...report, status: "failed", summary: result.output || result.stderr }; }
          }
          reports.push(report);
          const files = Array.isArray(report.filesChanged) ? report.filesChanged.length : 0;
          const checks = Array.isArray(report.checks) ? report.checks.filter((check: any) => check.result === "pass").length : 0;
          logActivity({
            actor: "local",
            state: report.status === "completed" ? "completed" : "failed",
            title: `${report.status === "completed" ? "Finished" : "Stopped"}: ${task.title}`,
            detail: `${report.summary || "No summary"} (${files} file${files === 1 ? "" : "s"} changed, ${checks} check${checks === 1 ? "" : "s"} passed)`
          });
          if (report.status !== "completed") break;
        }
        ctx.ui.setStatus("orchestrator", "Frontier final review…");
        logActivity({ actor: "frontier", state: "running", title: "Reviewing the Local Worker’s evidence", detail: modelRef(config.planner) });
        const review = await ctx.modelRegistry.complete(planner, { systemPrompt: REVIEW_SYSTEM, messages: [userMessage(`Original goal:\n${goal}\n\nPlan:\n${JSON.stringify(plan)}\n\nWorker reports:\n${JSON.stringify(reports)}`)] }, { signal: ctx.signal, cacheRetention: "none" });
        const reviewText = review.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
        logActivity({ actor: "frontier", state: "completed", title: "Final review complete" });
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
