[![make.fun](https://make.fun/badge/competition/hidden-spec-cli-01-run-20261122)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun rank](https://make.fun/badge/competition/hidden-spec-cli-01-run-20261122/rank)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![make.fun reward](https://make.fun/badge/competition/hidden-spec-cli-01-run-20261122/reward)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# Build mend

`mend` is one command-line tool that applies AI-written edits in four formats
— unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls — to
a tree of text files, to the specification in `SPEC.md`. It finds the lines
each edit names even when the model drifted their whitespace or indentation
(three matching tiers), and changes every file or none.

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`main.ts` is written from scratch from `SPEC.md` (Node 22 standard library
only, deterministic). `runner.ts` is the kit's runner, kept verbatim: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.
