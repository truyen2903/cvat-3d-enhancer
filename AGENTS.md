# Repository Guidelines

## Project Structure & Module Organization

Meow is a Manifest V3 browser extension that enhances CVAT 3D annotation. `src/entrypoints/` contains background, content, page-bridge, and popup entry points. `src/core/` manages feature lifecycles and commands; `src/features/` groups annotation, productivity, and visualization features. Keep CVAT runtime adapters in `src/integration/cvat/`, browser services in `src/infrastructure/`, React UI in `src/ui/`, and shared types and schemas in `src/shared/`. Static assets live in `public/`; architecture and compatibility notes live in `docs/`.

## Build, Test, and Development Commands

- `npm ci`: install dependencies from the lockfile.
- `npm run dev`: start Vite with CRXJS for development.
- `npm run build`: type-check and generate the extension in `dist/`.
- `npm run typecheck` and `npm run lint`: check strict TypeScript and ESLint rules.
- `npm run format:check`: verify source and test formatting; `npm run format` applies formatting.
- `npm test`: run Vitest suites.
- `npm run test:security`: run security tests and the static secret scanner.
- `npm run test:e2e`: verify built extension artifacts with Playwright; build first.

Load `dist/` as an unpacked extension in Chrome or Brave. Check interactive changes on an authorized CVAT 3D job. Production build artifacts are tracked; regenerate them when delivering a bundle update.

## Coding Style & Naming Conventions

Use TypeScript with strict types; explicit `any` is forbidden. Follow Prettier: two-space indentation, single quotes, semicolons, ES5 trailing commas, and 100-character lines. Use kebab-case module filenames, PascalCase classes/types/components, and camelCase functions and variables. Match surrounding module exports and feature lifecycle patterns.

## Testing Guidelines

Vitest runs under jsdom across `tests/unit/`, `tests/integration/`, `tests/security/`, and `tests/compatibility/`; name files `*.test.ts`. Playwright uses `tests/e2e/*.spec.ts`. Add regression tests for behavior changes, especially runtime compatibility, event cleanup, and messaging validation. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Follow existing Conventional Commit subjects, such as `fix: release keyboard controls on blur` or `feat(qa): add distance checks`. Keep commits focused. PRs should explain behavior changes, reference relevant issues, list verification commands, and include screenshots for UI changes. Document CVAT compatibility limits when affected.

## Security & Configuration

Preserve Manifest V3 CSP restrictions and validate cross-context messages and origins. Keep credentials out of source and tracked bundles. Consult `SECURITY.md` for vulnerability reporting and `docs/threat-model.md` before changing trust boundaries.
