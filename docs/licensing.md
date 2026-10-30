# Licensing

| Part                                                                                 | Licence     | Where                                     |
| ------------------------------------------------------------------------------------ | ----------- | ----------------------------------------- |
| Everything in this repository (packages, CLI, gateway, local web UI, examples, docs) | Apache-2.0  | `LICENSE` at the root and in each package |
| Future cloud control plane                                                           | Proprietary | Separate repository, not yet created      |

Dependency policy (enforced in CI by `pnpm run check:licenses`, i.e. `scripts/check-licenses.mjs`):

- **Shipped dependencies:** Apache-2.0, MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, BlueOak-1.0.0, CC0-1.0, CC-BY-4.0, Python-2.0 or Unlicense.
- **Dev-only tooling:** the above, plus MPL-2.0. It is not distributed with SudoWall.

Anything else needs an ADR before it is added.
