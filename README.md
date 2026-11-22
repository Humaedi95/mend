# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Humaedi95/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Humaedi95/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format. It reads an edit an AI
model wrote — a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool calls as
JSON — into one written specification, finds the lines the edit names even
when whitespace or indentation drifted, and changes every file or none.

Run: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`

- `PATCH` is the patch file, relative to the working directory (the tree
  root). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`,
  `json`; `auto`, the default, detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: 0 when the tree is written, 1 when some edit failed (one
`error: <code> <path>` line per failed edit, then
`failed: <k> of <n> edits`, nothing written), 2 on a usage, missing-patch,
format or parse error (exactly one `error: ...` line).

Matching is tried at three tiers: exact lines, then lines equal once
trailing spaces and tabs are removed, then lines equal once leading and
trailing spaces and tabs are removed. At tier 2, added lines are
re-indented from the old lines' indent to the file's. A unified hunk takes
the occurrence nearest its (drifted) line number; a SEARCH/REPLACE block
needs exactly one occurrence; a V4A chunk follows anchors and a cursor.
Files keep their own line break (LF or CRLF) and their final line break,
except where a unified hunk's `\ No newline at end of file` says
otherwise. A move is reported as `R <old> -> <new>`.

`main.ts` is the whole tool (Node 22, standard library only); `runner.ts`
is the kit's trial runner, kept as it is, and `check.ts` runs the public
practice set (`node check.ts <practice.json>`).
