# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Vitest (version inferred from `package.json` devDependencies via parent monorepo)
- Config: `vitest.config.ts`

**Assertion Library:**
- Vitest built-in (`expect` from `vitest`)

**Run Commands:**
```bash
npm test              # Run all tests (vitest)
```

Watch mode and coverage commands are not configured at the package level (no explicit script entries beyond `"test": "vitest"`).

## Test File Organization

**Location:**
- All tests are co-located under `src/__tests__/`
- Never adjacent to the source file

**Naming:**
- `<subject>.test.ts` pattern
- Filenames mirror the module under test: `log-redaction.test.ts` → `src/log-redaction.ts`, `openai-shell-image-name.test.ts` → settings from `src/openai-skills.ts`, `openai-skills-hardening.test.ts` → `src/openai-shell-mount-helpers.ts`

**Structure:**
```
src/
  __tests__/
    log-redaction.test.ts
    openai-shell-image-name.test.ts
    openai-skills-hardening.test.ts
```

## Test Structure

**Suite Organization:**
```typescript
// Leading block comment describes the regression scenario
describe("subject — fix #N description", () => {
  it("describes the specific invariant being asserted", () => {
    // arrange
    // act
    // assert
  });
});
```

Suites are grouped by logical concern within a file. `openai-skills-hardening.test.ts` contains two separate `describe` blocks in the same file for `resolveContainerPathForHostPath` and `isPathUnderReadRoot`.

**Patterns:**
- `beforeAll` / `afterAll` used for DI stub wiring when the module under test uses `getOpenAIDeps()`: register a minimal stub in `beforeAll`, reset in `afterAll` via `_resetOpenAIDepsForTests()`
- `beforeEach` / `afterEach` not used — each test is fully self-contained
- Assertions use `expect(x).toBe(y)`, `expect(x).toEqual(y)`, `expect(x).not.toContain(y)`, `expect(x).toContain(y)`, `expect(x).toBe(true/false)`, `expect(x).endsWith(y)`

## Mocking

**Framework:** No vi.mock / sinon — the package avoids mocking the module system

**Patterns:**
The DI registry pattern (`registerOpenAIConnector` / `_resetOpenAIDepsForTests`) is used instead of module mocking:
```typescript
beforeAll(() => {
  registerOpenAIConnector({
    readConnectorConfigFromDatabase: <T>(_connectorId: string, fallback: T) => fallback,
  } as unknown as OpenAIConnectorDeps);
});

afterAll(() => {
  _resetOpenAIDepsForTests();
});
```

Stub deps objects use `as unknown as OpenAIConnectorDeps` to satisfy type narrowing when only the minimal required methods are provided.

**What to Mock:**
- Only the DI registry slot (`OpenAIConnectorDeps`) when the code under test calls `getOpenAIDeps()`
- External I/O (filesystem, Docker, OpenAI HTTP) is NOT mocked — tests are written against pure-function leaf modules that have no I/O

**What NOT to Mock:**
- The module under test itself
- Node built-ins (`path`) — these are imported directly and exercised for real
- `process.cwd()` — tests use the live working directory and assert on relative path transforms

## Fixtures and Factories

**Test Data:**
```typescript
// Inline factory function for settings objects
const SETTINGS = (over: Partial<SkillMountSettingsLike> = {}): SkillMountSettingsLike => ({
  containerWorkspacePath: "/workspace",
  readRoots: [process.cwd()],
  writeRoots: [],
  ...over,
});
```

The `SETTINGS` factory pattern (module-level constant, spread override) is the standard way to create test fixtures in this repo. Each test calls `SETTINGS()` with only the overrides it needs.

**Location:**
- Fixtures are defined inline at the top of the test file — no separate fixtures directory

**Canary tokens:**
```typescript
const CANARY = `CANARY_TOKEN_${Math.random().toString(36).slice(2)}_DO_NOT_LEAK`;
```
Used in `log-redaction.test.ts` to assert that dynamically-generated secrets never leak into serialized output.

## Coverage

**Requirements:** Not enforced — no coverage threshold configuration in `vitest.config.ts`

**View Coverage:**
```bash
# Not configured; can be run ad-hoc with:
npx vitest run --coverage
```

## Test Types

**Unit Tests:**
- All 3 test files are unit tests targeting pure-function leaf modules
- `log-redaction.test.ts`: tests `redactAuthorizationDeep` directly — no I/O, no network
- `openai-shell-mount-helpers.test.ts` (via `openai-skills-hardening.test.ts`): tests path-manipulation helpers with real `path` module
- `openai-shell-image-name.test.ts`: tests settings defaults via DI stub — no DB, no Docker

**Integration Tests:**
- Not applicable — the package has no integration test suite

**E2E Tests:**
- Not used at the package level

## Common Patterns

**Async Testing:**
Not applicable — all test cases are synchronous. The `openai-shell-image-name.test.ts` uses `beforeAll` (which vitest treats as async-capable), but the registration itself is synchronous.

**Error Testing:**
Not present — current tests assert on correct-path behavior. Error/rejection paths are not unit tested at the package level.

**Import chain isolation:**
The pure-function leaf module pattern is the key testing strategy. Modules with heavy import chains (`src/openai-skills.ts` pulls `@openai/agents`) cannot be fully imported in vitest without stub resolution. The test comment in `log-redaction.test.ts` explains this constraint explicitly:
```
// NOTE: writeOpenAILogFile lives in `../index`, whose import chain pulls
// @openai/agents (via ./openai-skills), which is not resolvable in this
// package's vitest sandbox.
```
New tests must either target leaf modules (no `@/` imports) or configure additional aliases in `vitest.config.ts` to stub the heavy deps.

**vitest.config.ts alias stubs:**
- `server-only` → `tests/__stubs__/server-only.ts` (monorepo path)
- `@/lib/database` → `tests/__stubs__/database.ts` (monorepo path)
- `@/(.+)` → `<repoRoot>/src/$1`

These stubs live in the host monorepo's `tests/__stubs__/` directory, not in this package. This means running the tests requires the monorepo checkout context; running in full isolation (e.g., after `npm pack`) requires those stubs to be vendored or recreated.

---

*Testing analysis: 2026-06-09*
