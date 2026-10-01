## margin (markdown review threads)

Generated from `margin agent-help` by `bun run skill`; edit src/cli/agent-help.md.

Open a doc for the user with `margin <doc>`, once. The first line it prints is the page URL and the rest is the help below, so read it with `head -1`. Run again while the tab is open, it prints the same URL and opens no second tab.

After you answer a thread, end your turn with no chat message, not even a one-line summary. The user reads your replies in the page, so a chat echo repeats the doc and interrupts them. Write in chat only when they asked for updates there, or when something needs them that the doc cannot carry.

The page names you after your session, the title in your tab, so leave `--as` and `MARGIN_AGENT` off unless the user asks for another name.

```text
margin: review threads on a markdown doc. Use only these commands.

Monitor `margin watch <doc>` (max timeout; re-arm on expiry, nothing lost). One line per batch:
  new c7 c8 "2. Findings" | reply c3 | rejected c5
One shell call: margin pending <doc>; margin show c7 (if clipped); one more with every answer (; not &&).
No Monitor: margin pending <doc> --wait blocks until a batch; rerun.
Answer in the doc, then end the turn silently; chat only if asked for updates. Markdown is fine (bullets, `code`).
Before a big rewrite, answer or resolve threads it covers, or they detach.

margin pending <doc>  waiting threads + user edits (edit L13 path [-old-]{+new+})
  cN open doc: a whole-doc note, no quote. Reply or resolve; edit via suggest --find.
margin show <id>  full unit + thread
margin reply <id> "text" [--resolve]
margin suggest <id> --replace "text" [-m "note"]  proposes a new [[quote]]; the user accepts
  --apply: edits the file now; only when asked
margin suggest --find "exact" --replace "text" -m "why"  thread on text you change unasked
margin resolve <id>

reply <id> - and --replace - read stdin (last newline dropped); <<'EOF' for backticks or $.
Text starting with -: --replace=- or -- before it.
Acks: ok c3 replied|resolved;
err c3 <reason>[; detail]: not-found|resolved|deleted|detached|no-anchor|not-unique|before-missing|locked.
Id commands find the doc; on "pass the doc: a.md": margin reply a.md c3 "…".
The page names you by session title; --as <name> overrides.
```
