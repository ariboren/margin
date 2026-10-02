margin: review threads on a markdown doc. Use only these commands.

Monitor one `margin watch` for all docs (max timeout; re-arm on expiry, nothing lost). One line per batch, `<doc>: ` first if several:
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
