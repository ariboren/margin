# margin: plan

**Date:** 2026-09-30. Source: `BRIEF.md` plus owner interview (same day). Run with foreman on `main`; the foreman session itself runs on Opus, high effort.
Each table row is one implementer. No code exists yet.

## Step 0 (done 2026-09-30)

- Remote: `git@github.com:ariboren/margin.git`, set as `origin`, `gh` authenticated. `main` is pushed.
- The repo is **private** until release. It goes public at W4, so nothing quoted from the private sample goes into issues, commit messages, tests, screenshots or `docs/budget.md` (numbers only). `mockup/dist` is gitignored because it embeds the sample.
- Issues: one per wave, a checkbox per row of the wave table.
- Sample doc stays local: `fixtures/private/` is gitignored. W0 adds a script that copies it from a private path.

## Decided

From the interview:

- **Agent edits:** `margin suggest` by default. Direct apply on request, two routes: UI toggle (per thread, or whole session) and agent flag `--apply`. `--apply` is allowed by default; a per-doc "suggestions only" switch turns it off, and the ack then says it was downgraded. Applied edits show "changed by agent" with revert.
- **Dispatch:** immediate by default, watcher debounces 200 ms (trailing; Hold mode batches on purpose). Plus hold mode: comments stay drafts until "send all".
- **Lifecycle:** `margin doc.md` spawns or reuses one detached daemon, opens tab, prints URL, exits. One daemon, many docs, one doc per tab. Idle exit, `margin stop`. Answers brief Q6.
- **Runtime:** Bun required. Compiled binaries are first follow-up.
- **Sidecar:** hidden `.margin/` beside the doc.
- **Tables:** per-cell edit. "Edit as source" escape hatch for whole table or list.
- **Mockup:** real Preact components over an in-memory store. One direction, editorial: serif reading column, quiet sans for threads and controls, mono for code.
- **Outside edits** (editor, git): update page and re-anchor, marked "changed on disk". Never in the agent's feed.
- **Release bar:** Claude Code verified end to end. Other agents documented, unverified.

- **Wave 1 runs in parallel** with the mockup; owner accepted that mockup feedback may force a parser revision.
- **User edits:** word diff, no wake.
- **Tiers:** foreman on Opus high; the two fable spawns stay.
- **Licence:** MIT.
- **Spend:** one real Claude Code run in W3c is approved. No hard cap; keep it modest (one session, the seeded threads, no reruns without asking). Nothing else paid.

By this plan (veto any):

- **Sidecar format:** one append-only JSONL event log per doc, `.margin/<doc>.jsonl`. Threads are a fold of the log. Writers take `.margin/<doc>.lock`. Reasons: watcher is a tail, agent cursor is an event, git diffs are append-only, no state file to keep in sync.
- **One write path:** core `applyEdit` = lock, read, check `before` text still present, splice, atomic write, append event. Server (accept, user edit) and CLI (`--apply`) both call it. CLI works with no daemon running.
- **Ids:** thread ids `c1, c2…` allocated under lock, stable forever, 1 token each. Block ids are not persisted and not promised stable: storing them means ids in the markdown or a block table that rots on outside edits. Agent-facing refs are thread id, heading path, line number. UI keeps stable keys by aligning old and new parses (hash match, then LCS).
- **Block model:** mdast (GFM + frontmatter). Editable unit = smallest enclosing node among root child, list item, table cell, blockquote child. Unit = `[start, end)` offsets into source. Save splices those offsets only. BOM, CRLF, trailing newline untouched. Unchanged text on blur writes nothing.
- **Anchors in source space:** `exact` is a source substring (what `suggest` replaces), plus 32-char prefix and suffix, plus offset hint. Selection maps DOM to source through position-carrying text nodes; snaps to inline node edges when it cuts markup. v1 clamps a selection to one unit. Detached only when `exact` is gone; re-attaches if it returns.
- **Thread states:** draft → open → working → replied → resolved. `pending` claims what it returns (that is the live indicator, zero extra tokens). User reply reopens. Accept applies and resolves. Reject with note reopens, without note resolves. Working with no reply for 10 min shows "stalled".
- **Notification:** both. `margin watch` for Monitor: cursor-based, so re-arming after Monitor expiry loses nothing. `margin pending --wait` for agents without Monitor: blocks, then prints. Wakes on new comment, user reply, reject with note. Never on accept, resolve, edit.
- **Watch line is compact only** (owner, 2026-09-30, reversing the earlier capped-inline default after the W3c real run: inline and compact tied at $0.048 per resolved thread, 2.50 vs 2.25 requests, because the agent ran `show` on every batch and chains `pending` with it in one call). One compact line per batch; the agent reads threads through `pending`. The cursor advances on emit, so a re-armed watch never replays a batch; `watch` claims nothing.
- **User edits ride along:** they appear in the next `pending` output, they do not wake the agent. An "ask agent to follow through" action on an edit creates a thread, which does.
- **Edit feed is word-diff hunks, not unified diff.** Sample paragraphs are single lines, mean 468 chars, max 1,606. A unified hunk repeats the paragraph twice. Format: heading path, line, changed words with 4 words of context.
- **`pending` context is capped:** quote up to 600 B, then 240 B each side, clipped to the unit. Table: the cell, its column header, the row's first cell. Sample table rows average 676 chars; a whole table would cost thousands of tokens. `margin show <id>` returns the full unit on demand.
- **Conflict model (brief Q4):** server watches the doc's directory (editors rename on save). Own writes ignored by hash. Outside change: reparse, align, re-anchor, push to tabs. Open editor whose unit changed: bar with keep mine / take theirs, draft also kept in localStorage. Saves are compare-and-swap on the unit's `before` text, so unrelated changes elsewhere never block a save. File missing: banner, state kept.
- **Agent teaching (brief Q5):** `margin agent-help` is canonical, at most 1,700 B (raised from 1,500 B for the doc status lines, owner, 2026-10-01). Claude Code skill and `AGENTS.md` snippet are generated from it. `margin doc.md` prints it when stdout is not a TTY.
- **Security:** bind 127.0.0.1, check Host and Origin, per-daemon token, serve registered docs only, raw HTML in markdown rendered as text, images only from the doc's directory.

## Agent contract

```
margin <doc>                         open (daemon + tab)
margin watch <doc>                   per debounced batch: new c7 c8 c9 "2. Findings > A1" | reply c3 | rejected c5
                                     doc status first when it changed: approved | declined | reopened | finish c3 c5
margin pending <doc> [--wait] --json threads awaiting agent + user edits since last read; claims them
                                     line 1 while it stands: approved[ changed][: note] | declined[: note] | finish | reopened (once)
margin show <id>                     full unit + full thread
margin reply <id> "text" [--resolve]
margin suggest <id> --replace "text" [--apply] [-m "note"]     --replace - reads stdin (backticks, $)
margin suggest --find "exact" --replace "text"                 agent-initiated thread (follow-through)
margin resolve <id>
margin agent-help | stop | status | --version
margin setup [--user]                installs the Claude Code skill (project .claude/skills/margin, or ~/.claude/skills with --user); prints the AGENTS.md snippet
```

`pending` sends full messages for unclaimed threads, otherwise only messages after the agent's last one. Resolved threads never. `verdict` and `finish` are the user's events, written by the page; the agent CLI has no command that logs either, and `pending --wait` returns on each of the status words above.

## Token budget

Baseline: one read of the sample = 165,788 B, about 41k tokens.

| Operation                                   | Ceiling (stdout)                  |
| ------------------------------------------- | --------------------------------- |
| `watch`, per batch                          | 120 B                             |
| `pending`, per thread, excluding messages   | median 700 B, max 1,300 B         |
| `pending`, per user edit                    | 200 B + 60 B per extra hunk + changed words |
| `reply` / `resolve` / `suggest` ack         | 24 B                              |
| `agent-help`                                | 1,700 B                           |
| 10 seeded threads, full loop, all CLI output | 8 KB total, under 5% of the file |
| 10 seeded threads handed over, finish pass   | 5,000 B                           |

Turns matter more than bytes: each agent wake re-reads its context. Target 1 wake per batch. Per batch: `pending` (chained with `show` where needed) in one call, then one chained shell call for all replies.

Check: `bun run budget` seeds fixed threads and edits on a temp copy, runs every op, asserts against `budget.json`, prints the table. CI runs it on the public sample; locally on the private one. It also compares `--json` against a plain-text rendering; the contract teaches the smaller.

## Waves

| Wave | Work                         | Model  | Owns                                                                                                                     | Depends on     |
| ---- | ---------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ | -------------- |
| W0   | Scaffold                     | opus   | `package.json`, tsconfig, `.gitignore`, `CLAUDE.md`, `src/core/model.ts`, stub `src/core/blocks.ts`, `fixtures/edge*.md`, `scripts/link-sample.ts`, skeleton `scripts/budget.ts` + `budget.json` | step 0 |
| W1a  | Mockup                       | opus   | `src/client/**`, `mockup/**`                                                                                             | W0             |
| W1b  | Blocks and anchors           | opus   | `src/core/{blocks,anchor,align}.ts` + colocated `*.test.ts`                                                                          | W0             |
| W1c  | Log, threads, apply          | opus   | `src/core/{log,lock,threads,apply}.ts` + colocated `*.test.ts`                                                                          | W0             |
| W1d  | Diff, context, budget        | opus   | `src/core/{diff,context}.ts`, `scripts/budget.ts`, `budget.json`, `fixtures/public-sample.md`                            | W0             |
| W2a  | CLI                          | opus   | `src/cli/**` (ships a placeholder `agent-help.md`), `scripts/budget.ts`, `budget.json`                                   | W1b, W1c, W1d  |
| W2b  | Server and daemon            | opus   | `src/server/**`                                                                                                          | W1b, W1c       |
| W3a  | Wire UI to server            | opus   | `src/client/**`                                                                                                          | gate A, W2b    |
| W3b  | Agent contract text          | fable  | `src/cli/agent-help.md`, `skill/**`, `AGENTS.snippet.md`                                                                 | W2a            |
| W3c  | Loop end to end              | opus   | `test/e2e/**`, `scripts/fake-agent.ts`, `docs/budget.md`                                                                 | W2a, W2b       |
| W4   | Packaging                    | opus   | `LICENSE`, `.github/**`, build script, npm fields in `package.json`, `src/cli/setup.ts`                                  | gate B, W3     |
| W5   | Documenter                   | opus   | `README.md`, `SECURITY.md`, `docs/images/**`                                                                             | gate C         |
| W6a  | CI verification              | opus   | `.github/**`, `package.json` (`packageManager`, scripts, devDeps), `scripts/coverage.ts`                                 | W4             |
| W6b  | Property tests               | opus   | fuzz tests in `src/core/*.test.ts`                                                                                       | W6a (fast-check dep) |

Rules: W0 installs every dependency and freezes `model.ts`; later changes to either go through the foreman. Unit tests sit beside their module; only W3c owns `test/`. W3b replaces the contents of W2a's placeholder. W1 runs four agents in parallel on disjoint files. The mockup gate only holds W3a, so W2 proceeds during owner review. If gate A changes the editing model, W1b's owner revises the parser before W3a.

Tiers are for the spawned agents, per `~/.claude/model-policy.md`; the coordinator is Opus high. Only W3b and the gate B reviewer are fable. Reasons: W0 amplified (every wave builds on `model.ts`). Implementers pick their approach, checked by tests. W1d and W3c shape a measurement (floor). W3b is a prompt every agent session reads (unchecked, interpretive, amplified).

### Done checks

- **W0:** `bun test` and `bun run typecheck` pass. `package.json` licence is MIT. `model.ts` holds `Unit`, `Anchor`, `Thread`, `Event`, `DocStore`, CLI output shapes. `parseDoc` stub returns root-level units for the sample. `fixtures/edge.md` covers code fences, nested lists, frontmatter, HTML block, CRLF copy, no trailing newline (the sample has no code fences).
- **W1a:** `bun run mockup` builds one static page from the private sample. Clickable: select → comment (`c`) or suggest; threads in every state plus detached; scripted agent reply with live indicator; inline diff with `a`/`r`; `j`/`k`; click unit → raw edit → blur renders; cell edit on a wide table; "changed by agent" bar; hold and send all; outline with open-thread markers; light and dark. No horizontal page scroll. Screenshots of both themes in the report.
- **W1b:** for every unit in sample and edge fixtures, re-saving its own text is byte-identical; an edit changes only that range (prefix and suffix bytes compared). Anchors survive edits before, after and inside the quote; detached only when the quote is gone. Align keeps identity for unchanged units across an insert.
- **W1c:** 20 concurrent appending processes lose no event and allocate unique ids. Truncated last line is tolerated. Fold reproduces every state transition above. `applyEdit` refuses when `before` is absent and leaves the file untouched.
- **W1d:** `bun run budget` runs on the public sample with seeded data and fails on a breached ceiling. Word diff of a 3-word change in a 1,600-char paragraph is under 200 B. Public sample matches the private one's shape (long one-line paragraphs, wide tables, code spans) and adds fences.
- **W2a:** every command in the contract works against a temp dir with no daemon. `watch` inlines under the cap, falls back to compact over it, claims what it inlines, and re-armed mid-stream loses and repeats nothing. `--replace -` round-trips backticks and `$`. Budget passes with real output on both samples.
- **W2b:** `margin doc.md` returns in under 300 ms with a warm daemon and under 1 s cold, both measured and reported. Comment survives reload. Unit edit shows only those bytes in `git diff`. Outside edit reaches the tab within 300 ms. Save onto a changed unit returns conflict, file untouched. Bad Host, Origin or token gets 403. Opens via `orca tab create --url` when `ORCA_*` is set, else system browser.
- **W3a:** mockup components run on the server store unchanged. Conflict bar, agent listening chip, hold mode, auto-accept all work against a live daemon. Verified in Orca's browser and one other.
- **W3b:** `agent-help` within ceiling. A fresh sonnet agent given only that text names the right command for six scripted situations.
- **W3c:** scripted fake agent: UI comment → inline watch line → `suggest` → accept → exact bytes in file; the same through the compact line and `pending` for a large batch; also `--apply`, reject with note, held batch, user edit riding along. Budget numbers from the private sample recorded in `docs/budget.md`. Then one real Claude Code session on the sample, kept modest per the spend rule: tokens and turns per resolved thread recorded, and inline against compact-only measured, to confirm or reverse the watch-line default.
- **W4:** `bunx margin-md fixtures/public-sample.md` works from a packed tarball in a clean directory. The tarball ships `skill/margin/SKILL.md` and `AGENTS.snippet.md`; `margin setup` (project) and `margin setup --user` install the skill from the installed package and print the snippet, never editing `AGENTS.md`; idempotent, and it refuses to overwrite a changed skill without `--force`. CI runs typecheck, tests, budget and `bun skill/generate.ts --check`. Publish is the owner's step.
- **W6a:** CI writes a job summary (test counts, budget table); every action pinned to a commit SHA; zizmor clean; Dependabot for bun and actions; Bun pinned via `packageManager`; a coverage floor enforced by `scripts/coverage.ts` at the measured level. No paid services.
- **W6b:** the fixed-seed fuzz tests become fast-check property tests with shrinking; failures print a minimal case.
- **W5:** README written from the landed code, not the plan: tagline, install, demo capture on the public sample, agent setup (`margin setup`, `agent-help`, the `AGENTS.md` snippet), gitignore line for `.margin/`. Every command in it run once against a clean install. Nothing from the private sample.

### Gates

- **A, after W1a:** owner judges look and feel. Notes go back to the same agent.
- **B, after W2:** one fable review of the write path only (`blocks`, `anchor`, `apply`, `log`, `lock`, server save and watch). Data loss and concurrency; a miss here is costly.
- **C, after W4 (before W5):** foreman's standard gate over the code in the whole range: simplify (sonnet), review (opus), fix. W3b's text is out of scope here; its own done check and the acceptance run cover it.
- **Acceptance (owner), after W5:** a fresh Claude Code session resolves threads on the sample using only the README.

## v1 and later

- **v1:** everything above. macOS and Linux.
- **Later:** compiled binaries, Codex and Cursor verified, doc switcher, table row add/remove, code highlighting, mermaid and math, log compaction, cross-unit selections, Windows, MCP server.
- **Good enough to open-source:** byte-exact suite green, budget check in CI, localhost hardening, one-command install on a clean machine, acceptance run passed.

## Unresolved questions

None block W0 to W2.

1. npm publisher for `margin-md` (free as of 2026-09-30): probably the owner's account. Decide at W4.
