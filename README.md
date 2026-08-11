# Pi Frontier/Local Orchestrator

A small [Pi coding agent](https://github.com/badlogic/pi-mono) extension that spends frontier-model tokens where they matter and delegates routine repository work to a local OpenAI-compatible model.

`/orchestrate` runs a sequential planner/executor/reviewer workflow:

1. A ChatGPT/Codex model creates a structured task plan.
2. Each task runs in a fresh, ephemeral Pi subprocess using the local model and normal repository tools.
3. The worker returns a compact JSON handoff. Ambiguity, architectural choices, security-sensitive work, repeated test failures, and missing context trigger one frontier escalation/retry.
4. The frontier model reviews the plan and worker evidence and returns a final verdict.

## What you see while it runs

The transcript keeps a color-coded activity trail, so ownership is visible at a glance:

- **FRONTIER** — planning, difficult reasoning, escalation decisions, and final review
- **LOCAL** — repository exploration, edits, commands, tests, and routine debugging
- **ORCHESTRATOR** — workflow-level failures or control messages

Running work uses a colored dot, completed work a green check, escalations a yellow arrow, and failures a red cross. Each Local Worker entry identifies the task, local model, changed-file count, and passed-check count. The footer also shows the currently active phase. Colors use the active Pi theme rather than hard-coded terminal escape sequences.

The worker has an isolated context window, but shares the current working tree so edits and test results carry across tasks. Tasks are sequential in v1 to avoid conflicting edits.

## Requirements

- Pi with package/extension support
- Node.js 20+
- ChatGPT/Codex authenticated in Pi (`/login`)
- A local OpenAI-compatible server such as llama.cpp

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

After publishing to GitHub:

```bash
pi install git:github.com/YOUR_USERNAME/pi-frontier-local-orchestrator
```

Restart Pi or run `/reload`, then:

```text
/orchestrate add input validation to the signup endpoint and cover it with tests
```

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

Create an empty repository named `pi-frontier-local-orchestrator`, then run:

```bash
git init
git add .
git commit -m "Initial Pi planner-executor extension"
git branch -M main
git remote add origin git@github.com:YOUR_USERNAME/pi-frontier-local-orchestrator.git
git push -u origin main
```

Or, with GitHub CLI already authenticated:

```bash
gh repo create pi-frontier-local-orchestrator --public --source=. --remote=origin --push
```

## Limitations

- v1 executes tasks sequentially and allows one escalation retry per task.
- Final review uses compact reports, not the worker's full transcript. This controls frontier-token use but relies on accurate worker reporting.
- The extension does not commit, push, or create branches.

## License

MIT
