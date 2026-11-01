# ADR 0025: Parse agent code with @babel/parser, not TypeScript

Status: accepted, 2026-11-01

## Context

The `sdk_read_only` policy condition ([ADR 0023](0023-audit-recheck-fixes.md), update of 2026-11-01) parses the code an agent sends to Dodo's `execute` tool and proves it is a plain read. The first version used the TypeScript compiler (6.0.3) as its parser. That made TypeScript, about 24 MB, a runtime dependency of the published `sudowall` package, and the first check cost about 200 ms.

The decision rule set for this change: run the same 100 classifier cases (88 must not be proven, 12 must be proven) against `@babel/parser` with its `typescript` plugin, and switch only if every case passes.

Neither parser is the one that runs the code. `dodopayments-mcp` 2.59.0 checks the code with TypeScript 5.9.3 (`createSourceFile` and type diagnostics, in `code-tool-worker.ts`), then runs it in Deno, which parses it again with its own parser: `import('data:application/typescript;base64,...')` of the code plus `export default run;`. Choosing TypeScript did not make our reading identical to Deno's, and choosing Babel does not either. Where the parsers differ, the check must fail closed; the parser-differential cases are in `packages/policy/test/sdk-read-only.cases.ts`.

## Method

- The cases moved to `packages/policy/test/sdk-read-only.cases.ts`, so the same list runs against both implementations.
- The Babel version is a node-for-node port of the TypeScript one. It parses the same text (the code plus `\nexport default run;`) as an ES module, with `errorRecovery: false`, so any syntax error throws and the code is not proven.
- Babel's tree needs three checks the TypeScript tree did not. Without them, 2 of the 100 cases fail; with them, none do:
  - Directives (`'use strict'`) are kept in `directives`, not in the statement list. They are refused at the top level and in the function body. Without this, case 92 (a directive) is proven.
  - Parentheses are marked with `extra.parenthesized` instead of a node. A parenthesised expression is refused. Without this, case 93 (a parenthesised call) is proven.
  - Array holes are `null` elements. They are refused.
- `a?.b()` and `a.b?.()` parse as `OptionalCallExpression` in Babel, so they are not calls the check accepts.

## Results

Run on 2026-11-01, Fedora 44 (x86_64), Node.js 24.22.0, AMD Ryzen 7 7735HS.

All 100 cases pass with both parsers (`TypeScript 0 failures, Babel 0 failures`).

|                                                                            |   TypeScript 6.0.3 |                                        @babel/parser 8.0.7 |
| -------------------------------------------------------------------------- | -----------------: | ---------------------------------------------------------: |
| Installed size of the parser and its dependencies                          |       24,346,827 B | 1,944,173 B (`@babel/parser`, `@babel/types`, two helpers) |
| Cold check: load the parser and check one read, fresh process, median of 5 |           190.8 ms |                                                    22.0 ms |
| Warm check, a two-call proven read, mean of 5,000, median of 5 runs        |            0.44 ms |                                                   0.019 ms |
| Warm check, a write (not proven)                                           |            0.39 ms |                                                   0.018 ms |
| Warm check, a 16,059-character proven read (near the 16 KiB limit)         |       not measured |                                                    1.02 ms |
| `npx sudowall --version` from an empty npm cache: installed `node_modules` |      126,634,060 B |                      104,232,775 B (−22,401,285 B, −17.7%) |
| Same: npm cache after the install                                          |      204,808,797 B |                                              179,660,274 B |
| Same: wall time, 3 runs each, alternating                                  | 5.17, 5.11, 5.25 s |                                         5.36, 5.68, 5.18 s |

The install time difference is within the noise of the network; three runs are not enough to show one. The `npx` runs used the built 0.7.0 package packed twice, with only the parser dependency changed in its `package.json` (the bundled code differs by a few kilobytes); both printed `0.7.0`. Each run used a new empty `--cache` directory.

Per case:

|   # | Expected   | Case                                             | TypeScript 6.0.3 | @babel/parser 8.0.7 |
| --: | ---------- | ------------------------------------------------ | ---------------- | ------------------- |
|   1 | proven     | a list with a literal query                      | pass             | pass                |
|   2 | proven     | a list without arguments                         | pass             | pass                |
|   3 | proven     | a retrieve by literal id                         | pass             | pass                |
|   4 | proven     | a retrieve by a local string constant            | pass             | pass                |
|   5 | proven     | a list by a local query constant                 | pass             | pass                |
|   6 | proven     | two reads returned together                      | pass             | pass                |
|   7 | proven     | a property of a read result                      | pass             | pass                |
|   8 | proven     | a read as a statement                            | pass             | pass                |
|   9 | proven     | another parameter name                           | pass             | pass                |
|  10 | proven     | an any-typed parameter                           | pass             | pass                |
|  11 | proven     | comments that mention writes                     | pass             | pass                |
|  12 | proven     | strings that look like code                      | pass             | pass                |
|  13 | not proven | a write                                          | pass             | pass                |
|  14 | not proven | a read and a write                               | pass             | pass                |
|  15 | not proven | a write hidden behind &&                         | pass             | pass                |
|  16 | not proven | a write in an array                              | pass             | pass                |
|  17 | not proven | a read-named method that is not list or retrieve | pass             | pass                |
|  18 | not proven | a resource outside the allowlist                 | pass             | pass                |
|  19 | not proven | a raw client request                             | pass             | pass                |
|  20 | not proven | a raw client get                                 | pass             | pass                |
|  21 | not proven | a method reference, not a call                   | pass             | pass                |
|  22 | not proven | a call on a read result                          | pass             | pass                |
|  23 | not proven | a nested resource                                | pass             | pass                |
|  24 | not proven | retrieve with request options                    | pass             | pass                |
|  25 | not proven | list with request options                        | pass             | pass                |
|  26 | not proven | retrieve without an id                           | pass             | pass                |
|  27 | not proven | retrieve with an object                          | pass             | pass                |
|  28 | not proven | list with a string                               | pass             | pass                |
|  29 | not proven | an alias of the client                           | pass             | pass                |
|  30 | not proven | an alias of a resource                           | pass             | pass                |
|  31 | not proven | an alias of a method                             | pass             | pass                |
|  32 | not proven | a constant that shadows the client               | pass             | pass                |
|  33 | not proven | a redeclared constant                            | pass             | pass                |
|  34 | not proven | a constant named like the client                 | pass             | pass                |
|  35 | not proven | bracket access on the client                     | pass             | pass                |
|  36 | not proven | bracket access on a method                       | pass             | pass                |
|  37 | not proven | a computed resource                              | pass             | pass                |
|  38 | not proven | a computed query key                             | pass             | pass                |
|  39 | not proven | spread arguments                                 | pass             | pass                |
|  40 | not proven | a spread query                                   | pass             | pass                |
|  41 | not proven | optional chaining on the client                  | pass             | pass                |
|  42 | not proven | optional chaining on a resource                  | pass             | pass                |
|  43 | not proven | an optional call                                 | pass             | pass                |
|  44 | not proven | a template id                                    | pass             | pass                |
|  45 | not proven | a plain template id                              | pass             | pass                |
|  46 | not proven | a tagged template                                | pass             | pass                |
|  47 | not proven | an escaped resource name                         | pass             | pass                |
|  48 | not proven | an escaped method name                           | pass             | pass                |
|  49 | not proven | an escaped write disguised                       | pass             | pass                |
|  50 | not proven | an escaped client name                           | pass             | pass                |
|  51 | not proven | an escaped query key                             | pass             | pass                |
|  52 | not proven | eval                                             | pass             | pass                |
|  53 | not proven | Function                                         | pass             | pass                |
|  54 | not proven | fetch                                            | pass             | pass                |
|  55 | not proven | dynamic import                                   | pass             | pass                |
|  56 | not proven | Reflect                                          | pass             | pass                |
|  57 | not proven | globalThis                                       | pass             | pass                |
|  58 | not proven | a for loop calling the client                    | pass             | pass                |
|  59 | not proven | for await over a list                            | pass             | pass                |
|  60 | not proven | a while loop                                     | pass             | pass                |
|  61 | not proven | an if                                            | pass             | pass                |
|  62 | not proven | a try block                                      | pass             | pass                |
|  63 | not proven | a nested function                                | pass             | pass                |
|  64 | not proven | a getter in a query                              | pass             | pass                |
|  65 | not proven | a method in a query                              | pass             | pass                |
|  66 | not proven | a **proto** key                                  | pass             | pass                |
|  67 | not proven | a nested object in a query                       | pass             | pass                |
|  68 | not proven | a non-literal query value                        | pass             | pass                |
|  69 | not proven | a call-result constant as an argument            | pass             | pass                |
|  70 | not proven | an undeclared identifier                         | pass             | pass                |
|  71 | not proven | a constant used before it is declared            | pass             | pass                |
|  72 | not proven | a type assertion                                 | pass             | pass                |
|  73 | not proven | a non-null assertion                             | pass             | pass                |
|  74 | not proven | type arguments                                   | pass             | pass                |
|  75 | not proven | a typed constant                                 | pass             | pass                |
|  76 | not proven | an extra top-level statement                     | pass             | pass                |
|  77 | not proven | a top-level constant                             | pass             | pass                |
|  78 | not proven | an exported function                             | pass             | pass                |
|  79 | not proven | an arrow function                                | pass             | pass                |
|  80 | not proven | a non-async function                             | pass             | pass                |
|  81 | not proven | a generator                                      | pass             | pass                |
|  82 | not proven | two parameters                                   | pass             | pass                |
|  83 | not proven | a default parameter                              | pass             | pass                |
|  84 | not proven | a destructured parameter                         | pass             | pass                |
|  85 | not proven | a typed parameter other than any                 | pass             | pass                |
|  86 | not proven | another function name                            | pass             | pass                |
|  87 | not proven | a let                                            | pass             | pass                |
|  88 | not proven | a using declaration                              | pass             | pass                |
|  89 | not proven | an await using declaration                       | pass             | pass                |
|  90 | not proven | a var                                            | pass             | pass                |
|  91 | not proven | two declarations in one                          | pass             | pass                |
|  92 | not proven | a directive                                      | pass             | pass                |
|  93 | not proven | a parenthesised call                             | pass             | pass                |
|  94 | not proven | this                                             | pass             | pass                |
|  95 | not proven | a syntax error                                   | pass             | pass                |
|  96 | not proven | an unterminated comment                          | pass             | pass                |
|  97 | not proven | merge conflict markers                           | pass             | pass                |
|  98 | not proven | empty code                                       | pass             | pass                |
|  99 | not proven | only a comment                                   | pass             | pass                |
| 100 | not proven | a huge input                                     | pass             | pass                |

## Decision

- `@babel/parser` 8.0.7, pinned exactly, replaces TypeScript as the runtime dependency of `@sudowall/policy`. It is loaded with `require` on the first `sdk_read_only` check, as TypeScript was. `@babel/types` 8.0.10 is a dev dependency for its type definitions only. 8.0.7 was chosen over 8.0.10 because it was more than three weeks old (published 2026-10-07).
- `@babel/parser` 8 declares `engines: ^22.18.0 || >=24.11.0`. SudoWall's `engines` become `>=24.11.0` (root: `>=24.11.0 <25`). Node 24.0 to 24.10 are no longer supported.
- TypeScript stays a dev dependency of the repository (ADR 0011).

## Consequences

- An install is about 22 MB smaller, and the first Dodo `execute` check is about 170 ms faster.
- A third parser now reads the code: Babel here, TypeScript in Dodo's pre-check, Deno when it runs. The check stays sound only while it refuses everything outside its narrow shape. The parser-differential cases cover the known gaps; any new gap must be a new not-proven case first.
- `@babel/parser` is MIT. It publishes often (8.0.7 to 8.0.10 in three weeks); upgrades must rerun the full case list.
