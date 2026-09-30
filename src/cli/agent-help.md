margin: review threads on a markdown doc. Use only these commands.

Monitor `margin watch <doc>` (max timeout; re-arm on expiry, nothing is lost). One line per batch:
  new c7 c8 "2. Findings" | reply c3 | rejected c5
Then one shell call: margin pending <doc>; margin show c7 (if the clipped context is not enough),
and one more with every answer, commands joined by ; not &&.
No Monitor: margin pending <doc> --wait   blocks for the next batch; rerun after.

margin pending <doc>   waiting threads + user edits (edit L13 path, [-old-]{+new+})
margin show <id>       full unit + thread
margin reply <id> "text" [--resolve]
margin suggest <id> --replace "text" [-m "note"]   proposes a new [[quote]]; the user accepts (default)
  same with --apply    edits the file now; only if the user asked for that
margin suggest --find "exact" --replace "text" -m "why"   thread on text you change unasked (e.g. after a user edit)
margin resolve <id>

--replace - reads stdin (one trailing newline dropped): quoted heredoc <<'EOF' for backticks or $.
Text starting with -: --replace=-, or -- before it.
Acks: ok c3 replied|resolved; ok c3 downgraded (suggestions-only doc; proposed instead);
err c3 <reason>[; detail]: not-found|detached|not-unique|before-missing.
Id commands find the doc; on "pass the doc: a.md" put it first: margin reply a.md c3 "…".
