---
name: margin
description: Answer review threads on a markdown doc through the margin CLI. Use when a doc is open in margin, when `margin watch` or `margin pending` prints a batch, or when a thread id like c3 needs a reply or suggestion.
---

Generated from `margin agent-help` by `bun run skill`; edit src/cli/agent-help.md.

Open a doc for the user with `margin <doc>`, once. The first line it prints is the page URL and the rest is the help below, so read it with `head -1`. Run again while the tab is open, it prints the same URL and opens no second tab.

Keep one `margin watch`, with no path, for every doc you open. It follows the docs your session opens, including ones opened after it started, so never start a second watch. If its first line starts with `only`, margin found no session id and is watching that one doc: set `MARGIN_SESSION` to a name of your own on every margin command, run `margin pending <doc>` on each doc so the session lists it, then start the watch again. Or keep one watch per doc, each named by its path.

Never end a margin turn with an empty reply, which the user sees as a blank bullet. End it with a two-or-three-word confirmation and nothing else, for example "Margin watcher re-armed." after re-arming the watch and "Answered in margin." after handling threads. No summary of what you wrote in the doc, no status, no question. That covers answering a thread, a watch expiring, re-arming it, and letting one lapse. The user reads your replies in the page, so a chat echo repeats the doc and interrupts them, and a note that a watch expired gives them nothing to act on. Write more in chat only when they asked for updates there, for a critical alert, or at a handoff point. A critical alert: comments cannot reach you (the watch or the daemon is broken), an answer failed, or something needs the user that the doc cannot carry. A handoff point: the user approved, declined or asked you to finish the doc and that changes what you do next, or work the doc set in motion is done.

The page names you after your session, the title in your tab, so leave `--as` and `MARGIN_AGENT` off unless the user asks for another name.

```text
margin: review threads on a markdown doc. Use only these commands.

Monitor one `margin watch` for all docs (max timeout; re-arm on expiry, nothing lost; on "only <doc>" do as it says). One line per batch, `<doc>: ` first if several:
  new c7 c8 "2. Findings" | reply c3 | rejected c5
One shell call: margin pending <doc>; margin show c7 (if clipped); one more with every answer (; not &&).
No Monitor: margin pending <doc> --wait blocks until a batch; rerun.
Answer in the doc (Markdown ok: bullets, `code`). End every margin turn in 2-3 words, never empty ("Margin watcher re-armed.", "Answered in margin."); more only if asked, or something the doc cannot carry needs the user.
Before a big rewrite, answer or resolve threads it covers, or they detach.
Doc status (watch; pending line 1):
  finish c3 c5: settle each, ask nothing, stop: suggest --apply + resolve, or reply --resolve
  approved: do what the doc says; approved changed: edited since; declined: stop until reopened

margin pending <doc>  waiting threads (now working) + user edits (edit L13 path [-old-]{+new+})
  cN open doc: a whole-doc note, no quote. Reply or resolve; edit via suggest --find.
margin show <id>  full unit + thread
margin reply <id> "text" [--resolve]
margin suggest <id> --replace "text" [-m "note"]  proposes a new [[quote]]; the user accepts
  --apply: edits the file now; only when asked
margin suggest --find "exact" --replace "text" -m "why"  thread on text you change unasked
margin resolve <id>

reply <id> - and --replace - read stdin; <<'EOF' for backticks or $.
Text starting with -: --replace=- or -- before it.
Acks: ok c3 replied|resolved;
err c3 <reason>[; detail]: not-found|resolved|deleted|detached|no-anchor|not-unique|before-missing|locked.
Id commands find the doc; on "pass the doc: a.md": margin reply a.md c3 "…".
```
