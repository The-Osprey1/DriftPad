# Contributing

## Setup

Use Node.js 22 or newer and npm. `.nvmrc` records the version used by web CI.
Run `npm ci` from the repository root, then `npm run dev`.

`package-lock.json` is the dependency lockfile. Use `npm install` when deliberately
adding or updating dependencies, and commit the resulting lockfile with
`package.json`. Do not add lockfiles for other package managers.

## Before opening a pull request

1. Run `npm run check` for web changes.
2. Run `pio run --project-dir firmware` for firmware changes.
3. Update documentation when commands, setup, or behavior change.
4. Describe what changed and which checks actually ran. Report manual browser and
   hardware observations separately from software test results.

See [docs/testing.md](docs/testing.md) for coverage and manual check procedures.

## Code and files

- Keep React components in `src/components/`, browser services in `src/services/`,
  and the software DSP model in `src/engine/`.
- Put TypeScript unit tests beside the code as `*.test.ts` files.
- Keep firmware headers in `firmware/include/` and implementation in `firmware/src/`.
- Store reusable design decisions and project notes in `docs/`. Local AI tool
  artifacts, caches, build output, and environment files are ignored.
- Follow the surrounding code style. `.editorconfig` defines basic whitespace
  settings, and `.gitattributes` normalizes text files to LF across platforms.
- `npm run lint` is a compatibility alias for TypeScript checking, not a style linter.

## Canvas animation maintenance

High-frequency sensor and log updates can rerender the parent of `OledCanvas`.
Keep changing values in refs when they are consumed by a long-running animation
loop. Adding those values as effect dependencies can tear down and recreate the
`requestAnimationFrame` loop on every update. Preserve cleanup when the component
unmounts, and verify the display still receives fresh state after changes.
