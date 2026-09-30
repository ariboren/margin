# margin

Local markdown review tool: Google Docs style comments and suggestions on a `.md` file, where the
collaborator is the AI agent that wrote it, talking to the page through a token-cheap CLI.
`PLAN.md` is the spec (its Decided section is final); `BRIEF.md` is the product brief. Both are
foreman-only.

## Stack

- Bun 1.3 only, no Node tooling. TypeScript strict (`tsc` 7, native).
- Browser client: Preact + Tailwind v4, prebuilt by `scripts/build.ts` into `dist/client/`; users
  never run a build. Fonts (`@fontsource-variable/*`) are imported from the client entry, not the
  Tailwind input.
- Markdown: `mdast-util-from-markdown` with GFM and frontmatter extensions (no unified). Word diff:
  `diff` (jsdiff).

## Layout

- `src/core/model.ts`: shared types (units, anchors, events, threads, `DocStore`, CLI output
  shapes). Frozen; changes go through the foreman.
- `src/core/*.ts`: blocks, anchors, log, threads, apply, diff, context. Tests beside each module
  as `*.test.ts`.
- `src/client/`: Preact UI (entry `src/client/main.tsx`, Tailwind input `src/client/app.css`).
- `src/server/`: daemon. `src/cli/main.ts`: the `margin` bin.
- `mockup/`: static mockup build. `scripts/`: build, budget, link-sample. `test/e2e/`: end to end.
- `fixtures/`: byte-exact edge cases; `fixtures/private/` is gitignored.

## Commands

- `bun run typecheck`, `bun test`, `bun run build`, `bun run mockup`, `bun run budget`
- `bun run link-sample <path>` (or `MARGIN_SAMPLE=<path>`): copies the private sample to
  `fixtures/private/sample.md`.
- `bunx prettier --write <files>`: scoped formatting only.

## Rules

- **Byte-exact saves.** Edits splice `[start, end)` source offsets and nothing else. BOM, CRLF and
  a missing trailing newline survive. Offsets are UTF-16 indices into `decodeSource` output (BOM
  kept at index 0; micromark drops it, so parse offsets shift by one when present).
- **Fixtures are bytes, not text.** Write them with Bash (`printf`, heredoc, `perl`), never the
  Write/Edit tools, and check with `od -c | tail`. `.prettierignore` and `.gitattributes`
  (`-text`) protect `fixtures/**`.
- **Private sample.** Nothing quoted from it goes into the repo, issues, commits, tests, snapshots
  or screenshots. Numbers are fine. Tests that use it skip when it is absent and assert structure
  only.
- **Sidecar.** `.margin/<doc>.jsonl` is only read and written through the log module API.
- **Dependencies and scripts** in `package.json` are frozen; ask the foreman.

## Code style

- 4-space indentation, named exports only, `async/await` (no `.then()` chains).
- Types colocated with their module; cross-module types in `src/core/model.ts`.
- Comments only for the non-obvious why.
- Sentence case for all UI copy. Prefer `gap` over margins.
