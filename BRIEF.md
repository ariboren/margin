# margin: planning brief

**Date:** 2026-09-30
**For:** the planning session (Fable, high effort). Output a plan, not code.

## The problem

I collaborate with AI agents on long markdown documents (audits, plans, design docs). Chat is linear, but review is not: one document raises many separate points, each needing its own discussion and resolution. In chat those threads interleave and get lost.

## The product

`margin` (npm `margin-md`, command `margin`): a local, open-source markdown review tool. It works like Google Docs comments and suggestions, and the collaborator is the AI agent that wrote the file.

```
margin path/to/doc.md
```

This starts a local server and opens the doc in a browser tab (primary host: Orca's built-in browser via `orca tab create --url`; it must also work in any browser). It should open instantly.

Tagline direction: "review AI-written markdown like a Google Doc." It is agent-agnostic (Claude Code, Codex, Cursor, anything that can run a CLI). Do not use "Claude" in the name.

## Decided (do not re-litigate without a strong reason)

- **Local files are the source of truth.** The `.md` stays plain markdown in the user's repo. Comments live in a sidecar, e.g. `doc.md.comments.json` (or a `.margin/` dir; plan decides). No hosted service, no account.
- **Stack:** Bun server, one page, Preact + Tailwind, no build step for the user.
- **Comments and suggestions:** select text → comment or suggest a replacement. Threads sit in the margin beside their passage. States: open, agent working (live indicator), replied, resolved (folds away). Suggestions render as inline diffs with accept/reject.
- **Freeform edits, per block:** click a paragraph to edit its raw markdown in place; blur renders and saves. Only touched bytes change, so there is no rich-text round-trip reformatting of tables, lists or spacing, and git diffs stay clean. Rejected: a full WYSIWYG editor (TipTap/Milkdown rewrites markdown), and a split source/preview view (feels like an IDE).
- **Anchoring:** comments anchor by quoted text (W3C text-quote style: exact + prefix/suffix), re-resolved after every edit, and flagged as detached only when the quote is gone.
- **Concurrent edits:** if the agent changes a block the user has open, show a "changed by agent" bar with keep mine / take theirs. Never lose user text silently.
- **User edits are signals:** each save records the block's before and after, so the agent can see what the user rewrote and follow the change through (e.g. update a summary).
- **Beautiful, not a debug page:** a single reading column with strong typography, light and dark themes, an outline sidebar showing where open threads are, and keyboard-first controls (`c` comment, `j`/`k` next/previous thread, `a`/`r` accept/reject, `⌘↵` send).

## Hard requirement: token efficiency

The agent side must be cheap. Every design choice on the agent contract is judged by tokens per resolved thread.

- **`margin pending --json`:** only unresolved threads, each with its quote, the surrounding block, and the thread messages. Never the whole file, never resolved threads.
- **Agent replies go through the CLI:** `margin reply <id> "..."`, `margin resolve <id>`, `margin suggest <id> --replace "..."`. The agent never reads or rewrites the JSON sidecar directly.
- **The watcher emits one compact line per event** (`new-comment <id> <section>`), suited to Claude Code's Monitor tool, not file contents.
- **Edits by the agent are targeted replacements.** Consider whether suggestions should be the default path (the agent proposes, the user accepts) so that a full-file rewrite never happens.
- **The user-edit diff feed is compact:** block id + unified diff, only since the agent's last read.
- Measure it: the plan should include a rough token budget per operation and a way to check it (e.g. byte counts of CLI output on the sample doc).

## Open questions for the plan

1. Sidecar format and location; whether comment ids and block ids are stable across edits, and how.
2. Block model: how the markdown is split into editable blocks (mdast positions?) while keeping exact bytes on save. Tables, lists and code fences need care.
3. How the agent learns of new comments: Monitor on a watcher command, a poll command, or both. Also how an agent without Monitor (Codex, Cursor) uses it.
4. Conflict model when the file changes on disk (agent edit, git checkout, the user's editor) while the page is open.
5. Whether to ship a Claude Code skill and/or an `AGENTS.md` snippet that teaches any agent the CLI contract in a few hundred tokens.
6. Multi-document support (one server, several files) or strictly one file per invocation for v1.
7. Scope of v1 versus later; what makes it good enough to open-source.

## Sequencing I want

1. **A static clickable mockup first**, using a real long document as sample content: a private document from another project (400 lines, wide tables, code spans). It covers comments, suggestions and per-block editing with no persistence, so I can judge the look and feel before any wiring.
2. Then the server, the sidecar and the CLI agent contract.
3. Then the agent loop end to end (comment → agent notified → reply/suggest → UI updates).
4. Packaging for open source (README, npm, license).

## Plan output

Concise. Sessions sized for one implementer each, with file ownership, the done check for each session, and the model tier per session under `~/.claude/model-policy.md`. End with unresolved questions.
