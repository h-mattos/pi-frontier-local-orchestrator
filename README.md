# Pi Two-Model Orchestrator

A small [Pi coding agent](https://github.com/badlogic/pi-mono) extension that lets you choose any available model as the Planner and any available model as the Worker. A common setup uses ChatGPT/Codex for planning and a local OpenAI-compatible model for execution, but that pairing is not required.

`/orchestrate` runs a sequential planner/executor/reviewer workflow:

1. Your chosen Planner model creates a structured task plan.
2. Each task runs in a fresh, ephemeral Pi subprocess using your chosen Worker model and normal repository tools.
3. The Worker returns a compact JSON handoff. Ambiguity, architectural choices, security-sensitive work, repeated test failures, and missing context trigger one Planner escalation/retry.
4. The Planner reviews the plan and Worker evidence and returns a final verdict.

## What you see while it runs

The transcript keeps a color-coded activity trail, so ownership is visible at a glance:

- **PLANNER** — planning, difficult reasoning, escalation decisions, and final review
- **WORKER** — repository exploration, edits, commands, tests, and routine debugging
- **ORCHESTRATOR** — workflow-level failures or control messages

Running work uses a colored dot, completed work a green check, escalations a yellow arrow, and failures a red cross. Each Worker entry identifies the task, selected model, changed-file count, and passed-check count. The footer also shows the currently active phase. Colors use the active Pi theme rather than hard-coded terminal escape sequences.

The worker has an isolated context window, but shares the current working tree so edits and test results carry across tasks. Tasks are sequential in v1 to avoid conflicting edits.

## Requirements

- Pi with package/extension support
- Node.js 20+
- Any two models available in Pi (they may use the same or different providers)
- Authentication or endpoint configuration required by those providers

This extension follows Pi's current official APIs: `registerCommand`, `modelRegistry.find/complete`, custom messages, native provider configuration, and isolated `pi --mode json -p --no-session` workers.

## Configure models

Merge [`examples/models.json`](examples/models.json) into `~/.pi/agent/models.json`. It targets llama.cpp at `http://127.0.0.1:8080/v1`; change the model ID and context limits to match your server.

Copy [`examples/orchestrator.json`](examples/orchestrator.json) to `.pi/orchestrator.json` in the repository where you will run Pi:

```bash
mkdir -p .pi
cp /path/to/pi-frontier-local-orchestrator/examples/orchestrator.json .pi/orchestrator.json
```

Provider and model IDs must match what Pi shows in `/model`. The defaults are examples, not guaranteed catalog names.

## Install

For local development:

```bash
pi install /absolute/path/to/pi-frontier-local-orchestrator
```

From GitHub:

```bash
pi install git:github.com/h-mattos/pi-frontier-local-orchestrator
```

Restart Pi or run `/reload`, then:

```text
/orchestrate add input validation to the signup endpoint and cover it with tests
```

To choose from every model currently available in Pi, run:

```text
/orchestrate-models
```

The two selections apply for the current Pi session. If you run `/orchestrate` without selecting models and the project has no `.pi/orchestrator.json`, the same picker opens automatically before planning begins.

You can also override either model for one run:

```text
/orchestrate --planner openai-codex/gpt-5.3-codex --worker llama-cpp/qwen2.5-coder-14b fix the signup tests
```

Model IDs may contain additional slashes. Selection priority is: command-line override, session picker, `.pi/orchestrator.json`, then built-in example defaults.

### Persistent model selection

To keep the same Planner and Worker for a repository, create `.pi/orchestrator.json` in that repository:

```json
{
  "planner": {
    "provider": "openai-codex",
    "model": "gpt-5.3-codex"
  },
  "worker": {
    "provider": "llama-cpp",
    "model": "qwen2.5-coder-14b",
    "thinking": "off"
  },
  "maxEscalations": 1,
  "workerTimeoutMs": 900000,
  "workerTools": ["read", "grep", "find", "ls", "bash", "edit", "write"]
}
```

Use the exact provider and model IDs shown by Pi’s `/model` command. Commit this file when the whole team should share the pairing, or add it to `.gitignore` when it is specific to one machine.

## Configuration

`.pi/orchestrator.json` supports:

- `planner.provider`, `planner.model`
- `worker.provider`, `worker.model`, `worker.thinking`
- `workerTools`: Pi tools exposed to the local worker
- `workerTimeoutMs`: per-worker timeout
- `maxEscalations`: currently `0` or any positive value (v1 performs at most one retry per task)
- `escalationTriggers`: phrases included in the worker policy

Project-local extensions and configuration execute code and should only be used in trusted repositories. The spawned worker intentionally uses the same working tree and can edit files and run shell commands.

## Tests

```bash
npm test
npm run check
```

Tests cover configuration merging, structured JSON parsing, plan validation, model references, and JSON-mode output extraction. End-to-end tests require real Pi/provider credentials and are intentionally not part of the default suite.

## Publish to your GitHub account

The repository is [github.com/h-mattos/pi-frontier-local-orchestrator](https://github.com/h-mattos/pi-frontier-local-orchestrator). To push this local version:

```bash
git init
git add .
git commit -m "Initial Pi planner-executor extension"
git branch -M main
git remote add origin git@github.com:h-mattos/pi-frontier-local-orchestrator.git
git push -u origin main
```

If the `origin` remote already exists, update it instead:

```bash
git remote set-url origin git@github.com:h-mattos/pi-frontier-local-orchestrator.git
git push -u origin main
```

## Limitations

- v1 executes tasks sequentially and allows one escalation retry per task.
- Final review uses compact reports, not the Worker's full transcript. This controls Planner-token use but relies on accurate Worker reporting.
- The extension does not commit, push, or create branches.

## License

MIT
