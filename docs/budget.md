# Token budget: measured

Bytes of real CLI stdout, from `bun run budget` (public sample) and `bun run budget --sample private`
(the private sample, which is not in the repo). Ceilings are in `budget.json`; the method is in
`scripts/budget.ts`. Measured 2026-10-01 after the doc verdict and finish request. `agent-help` grew
with the no-chat rule, the `--as` naming line (ceiling raised 1,450 → 1,500 B, owner, 2026-09-30),
the named `resolved`, `deleted` and `locked` errors, and then the doc status lines (ceiling raised
1,500 → 1,700 B, owner, 2026-10-01); to fit, the `--as` line left the help text for the skill
preamble and the README. The rule that every margin turn ends silently, a watch re-arm included,
was added at no byte cost: `; show <id> for context` on the finish line and
`(last newline dropped)` on the stdin line paid for it. One watch for every doc the session opens
and the rule that a margin turn ends with a two-or-three-word confirmation, never an empty reply
(which the host renders as a blank bullet), then cost 130 B: the two example confirmations, the
`<doc>: ` prefix, the no-path form, and what to do when the watch says it covers `only <doc>`
because the agent has no session id (ceiling raised 1,700 → 1,830 B, owner, 2026-10-02). `watch`
is the widest line printed: `declined | new c1 … c10`, a decline beside ten new threads; an
ordinary batch is 20 B. It is measured on a watch naming one doc, which prints no prefix; a watch
covering several docs adds `<doc>: `, the doc's path from the working directory, to each line.

The stale skill notice is the one line `margin <doc>` adds for an agent, and only when an installed
skill that applies there is out of date: `margin skill 0.3.0 < 0.4.0: tell the user to run margin
update`. It costs nothing when the skill is current, is said at most once a day per copy, and stops
once the copy is refreshed or the user chose to keep theirs. It goes to stderr because the skill
has the agent read stdout with `head -1`, which would cut a line after the URL. Its ceiling is 70 B;
a line that would pass it (long version numbers) drops the versions and reads `margin skill old: …`.

| Operation                                    | Ceiling (B) | Public (B) | Private (B) |
| -------------------------------------------- | ----------: | ---------: | ----------: |
| `watch`, per batch, widest line              |         120 |         46 |          46 |
| `pending`, per thread, median                |         700 |        310 |         345 |
| `pending`, per thread, max                   |       1,300 |        664 |         674 |
| `pending`, per user edit (base)              |         200 |        120 |         147 |
| `reply` / `resolve` / `suggest` ack          |          24 |         16 |          16 |
| `agent-help`                                 |       1,830 |      1,827 |       1,827 |
| `margin <doc>`, stale skill notice (stderr)  |          70 |         63 |          63 |
| 10 seeded threads, full loop, all CLI output |       8,000 |      4,773 |       4,996 |
| 10 seeded threads handed over, finish pass   |       5,000 |      4,310 |       4,419 |

`pending` as plain text against `--json` for the same seeded state:

| Sample  | Text (B) | JSON (B) |
| ------- | -------: | -------: |
| Public  |    4,570 |    5,753 |
| Private |    4,793 |    5,987 |

The full loop is 4,773 B on a 71,296 B file (6.7%) and 4,996 B on a 165,788 B file (3.0%). Every
batch goes through `pending` (three calls, the first carrying the user edits); with the capped
inline line it was 3,800 B and 4,078 B. The loop now ends with the user approving as is: one
`approved` watch line and the `approved` header a fresh `pending` read prints, 18 B over the
4,755 B and 4,978 B measured before.

A finish pass, measured as a second loop and kept out of the first one's total, hands the same ten
threads to the agent and costs 4,310 B (public) and 4,419 B (private): the `finish c1 … c10` watch
line, one `pending` read with the `finish` header and every thread in full, and ten acks. Its
ceiling is 5,000 B (owner, 2026-10-01).

Decision (owner, 2026-09-30): the watch line is compact only, because the real session below tied
inline and compact at $0.048 per resolved thread; `watch` claims nothing and `pending` is the only
read path.

## Sample shape

| Measure                    | Public | Private |
| -------------------------- | -----: | ------: |
| Bytes                      | 71,296 | 165,788 |
| Paragraphs                 |     47 |      42 |
| Paragraph length, mean (B) |    539 |     869 |
| Paragraph length, max (B)  |  1,807 |   3,105 |
| Table rows                 |     57 |     170 |
| Table row length, mean (B) |    694 |     675 |
| Code spans                 |    260 |     808 |
| Code fences                |      6 |       0 |

## Real session (W3c)

One headless Claude Code session (`claude -p`, Opus 5.5, stream-json) on the private sample,
2026-09-30, at `ff9c7b4`, driven by `test/e2e/real-run.ts`. The driver played the user over the
daemon's HTTP protocol and fed each `margin watch` batch into the session. Compact batches were
forced with `MARGIN_WATCH_INLINE_CAP=0`, a seam since removed. Batch order: inline, compact, compact, inline, then one
large batch (two new threads, a reject with a note, a user edit), then one batch through the
agent's own Monitor. Tokens are from each turn's result event. Cost is notional (subscription).

| Batch     | Form    | Threads | Watch (B) | Requests | Input | Cache write | Cache read | Output | Cost ($) |
| --------- | ------- | ------: | --------: | -------: | ----: | ----------: | ---------: | -----: | -------: |
| Setup     |         |       0 |           |        2 |     4 |       6,389 |     28,276 |    191 |    0.061 |
| 1         | inline  |       2 |       210 |        5 |    10 |       6,418 |     99,825 |  1,697 |    0.105 |
| 2         | compact |       2 |        10 |        6 |    12 |       8,663 |    166,620 |  1,724 |    0.137 |
| 3         | compact |       2 |        10 |        3 |     6 |       1,915 |    100,092 |    909 |    0.054 |
| 4         | inline  |       2 |       413 |        5 |    10 |       2,937 |    178,549 |  1,304 |    0.085 |
| 5         | compact |       3 |       110 |        3 |     6 |       7,734 |    118,657 |  2,700 |    0.140 |
| Arm watch |         |       0 |           |        3 |     6 |       3,798 |    140,112 |    246 |    0.063 |
| Monitor   |         |       1 |           |        3 |     6 |       1,153 |    148,742 |    417 |    0.047 |

Per resolved thread, by arm:

| Arm                 | Threads | Requests | Input | Cache write | Cache read | Output | Cost ($) |
| ------------------- | ------: | -------: | ----: | ----------: | ---------: | -----: | -------: |
| Inline (1, 4)       |       4 |     2.50 |     5 |       2,339 |     69,594 |    750 |    0.048 |
| Compact-only (2, 3) |       4 |     2.25 |     4 |       2,644 |     66,678 |    658 |    0.048 |
| Large batch (5)     |       3 |     1.00 |     2 |       2,578 |     39,552 |    900 |    0.047 |
| All batches         |      12 |     2.08 |     4 |       2,402 |     67,707 |    729 |    0.047 |

Session total: 30 requests, $0.69 notional. Every thread got an answer. No permission denials.
Monitor was listed under `-p` and fired: the agent armed `margin watch` itself, and the next
comment started a new turn with no input from the driver.
