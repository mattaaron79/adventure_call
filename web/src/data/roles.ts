/**
 * The framework-role map (tic-22db): how execution reaches code that nothing
 * in the project calls.
 *
 * A call graph only sees calls the project makes.  Web routes, CLI commands,
 * event handlers, test functions, fixtures, properties and dunder methods are
 * all reached by something else -- a framework, a test runner, the language
 * itself -- so they have no in-project callers and look exactly like dead
 * code.  On the ../carnot export, 64% of callables have no caller at all;
 * treating that as "unused" would be wrong about nearly two thirds of the
 * codebase.  This file is the evidence that lets the classifier tell an
 * invisible entry point from a genuine orphan.
 *
 * It is deliberately DATA, not logic: a flat list of rules a human edits.
 * Every codebase has its own decorators, and a list welded into the
 * classifier is stale the moment it meets a second project.  Add a rule by
 * adding a line here; nothing else needs to change.  {@link DEFAULT_ROLE_RULES}
 * is only the default -- every consumer takes the rule list as an argument, so
 * a project's own map can be supplied instead.
 */

/**
 * One reason a symbol is reachable without an in-project call.
 *
 * A rule matches a symbol when EVERY field it declares matches; fields it
 * leaves out are not consulted.  So `{ role: 'test', name: '^test_', file:
 * '...' }` requires both a matching name and a matching path, while
 * `{ role: 'fixture', decorator: 'pytest.fixture' }` cares only about the
 * decorator.
 */
export interface RoleRule {
  /**
   * What kind of framework contact this names, e.g. 'route' | 'command' |
   * 'test' | 'fixture' | 'handler' | 'task' | 'property' | 'dunder'.  Free
   * text: the UI shows it, nothing branches on the value.
   */
  role: string
  /**
   * Decorator to match, written WITHOUT the `@` and without any call
   * arguments -- `pytest.fixture`, `app.route`, `on`.  Matching ignores
   * arguments, so this one entry covers `@on(Button.Pressed, "#allow")` and
   * `@on(Input.Submitted)` alike.
   *
   * A rule with a dotted name also matches the bare final segment, so
   * `pytest.fixture` matches both `@pytest.fixture` and the `@fixture` that a
   * `from pytest import fixture` produces.  It does not match in the other
   * direction: a bare rule stays bare.
   */
  decorator?: string
  /** Regular expression (source form) matched against the symbol's name. */
  name?: string
  /** Regular expression (source form) matched against the file path. */
  file?: string
}

/**
 * Where a test runner collects tests from.  Kept as one constant because two
 * rules share it and they must not drift apart.
 */
const TEST_FILE = '(^|/)tests?/|(^|/)test_[^/]*$|_test\\.[^/]*$'

/**
 * True when this path is somewhere a test runner collects from -- the same
 * definition {@link DEFAULT_ROLE_RULES} uses, exported so callers that ask
 * "are all of this function's callers tests?" (tic-1ecc) share one answer
 * rather than growing a second, drifting regex.
 */
export function isTestPath(filePath: string): boolean {
  return new RegExp(TEST_FILE).test(filePath)
}

/**
 * The default rules.  Aimed at what a Python codebase actually hits: the test
 * runner, the language's own dunder protocol, and the decorator vocabularies
 * of the common web, CLI and TUI frameworks.
 *
 * Two deliberate omissions, because including them would rescue orphans that
 * are not orphans' opposite:
 *
 * - `@staticmethod` and `@classmethod` do NOT go here.  They change how a
 *   method binds, not who calls it; a static method with no callers is as
 *   unused as any other function, and a rule for them would quietly launder
 *   dead code into "framework entry".
 * - `@dataclass` and friends decorate classes, not the callables this map is
 *   about.
 */
export const DEFAULT_ROLE_RULES: readonly RoleRule[] = [
  // The test runner collects by NAME, not by decorator -- which is why this
  // map cannot be decorators alone.  This single rule covers the largest
  // group of caller-less functions in a typical project by a wide margin.
  { role: 'test', name: '^test_', file: TEST_FILE },
  { role: 'fixture', decorator: 'pytest.fixture' },
  { role: 'fixture', name: '^(setup|teardown)(_module|_function|_class|_method)?$', file: TEST_FILE },

  // The language calls these itself: `__enter__`, `__repr__`, `__eq__` and
  // the rest of the protocol are invoked by syntax, never by a call the
  // parser can see.
  { role: 'dunder', name: '^__[a-z0-9_]+__$' },

  // Attribute access, not a call: `obj.thing` runs the getter with no call
  // expression anywhere for the parser to find.
  { role: 'property', decorator: 'property' },
  { role: 'property', decorator: 'cached_property' },

  // Web frameworks.
  { role: 'route', decorator: 'app.route' },
  { role: 'route', decorator: 'router.get' },
  { role: 'route', decorator: 'router.post' },
  { role: 'route', decorator: 'router.put' },
  { role: 'route', decorator: 'router.delete' },
  { role: 'route', decorator: 'app.get' },
  { role: 'route', decorator: 'app.post' },
  { role: 'route', decorator: 'app.put' },
  { role: 'route', decorator: 'app.patch' },
  { role: 'route', decorator: 'app.delete' },
  { role: 'route', decorator: 'app.websocket' },
  { role: 'route', decorator: 'app.middleware' },

  // CLI frameworks.
  { role: 'command', decorator: 'click.command' },
  { role: 'command', decorator: 'click.group' },
  { role: 'command', decorator: 'app.command' },

  // Event handlers and background work (Textual, Celery, and lookalikes).
  { role: 'handler', decorator: 'on' },
  { role: 'task', decorator: 'work' },
  { role: 'task', decorator: 'app.task' },
  { role: 'task', decorator: 'shared_task' },
]

/**
 * The matchable head of a decorator as the exporter records it: `@` and any
 * call arguments stripped.
 *
 * `@pytest.fixture` -> `pytest.fixture`, `@on(Button.Pressed, "#allow")` ->
 * `on`, and a decorator whose arguments run over several lines (the exporter
 * stores decorators verbatim, newlines included) -> its head all the same.
 */
export function decoratorHead(decorator: string): string {
  const withoutAt = decorator.trim().replace(/^@/, '')
  const head = withoutAt.split('(')[0]
  return head.trim()
}

/** True when `head` is the decorator this rule names, allowing the bare final
 *  segment of a dotted rule (see {@link RoleRule.decorator}). */
function decoratorMatches(rule: string, head: string): boolean {
  if (head === rule) return true
  const bare = rule.slice(rule.lastIndexOf('.') + 1)
  return bare !== rule && head === bare
}

/** A rule that matched, with the specific evidence, so the UI can say WHY a
 *  symbol counts as an entry rather than just asserting it does. */
export interface RoleMatch {
  role: string
  /** Human-readable evidence, e.g. `decorator @pytest.fixture`. */
  reason: string
}

/**
 * The first rule matching this symbol, or null.  Rules are tried in order, so
 * a more specific rule earns its place by sitting higher in the list.
 *
 * Invalid regular expressions in a rule are treated as non-matching rather
 * than thrown: the rule list is user-editable data, and one typo in it must
 * not take down the whole classification.
 */
export function matchRole(
  symbol: { name: string; file_path: string; decorators: readonly string[] },
  rules: readonly RoleRule[] = DEFAULT_ROLE_RULES,
): RoleMatch | null {
  for (const rule of rules) {
    if (rule.name !== undefined && !test(rule.name, symbol.name)) continue
    if (rule.file !== undefined && !test(rule.file, symbol.file_path)) continue

    if (rule.decorator === undefined) {
      const evidence =
        rule.name !== undefined ? `name matches /${rule.name}/` : `path matches /${rule.file}/`
      return { role: rule.role, reason: evidence }
    }
    const hit = symbol.decorators.find((d) => decoratorMatches(rule.decorator!, decoratorHead(d)))
    if (hit !== undefined) return { role: rule.role, reason: `decorator @${decoratorHead(hit)}` }
  }
  return null
}

function test(source: string, value: string): boolean {
  try {
    return new RegExp(source).test(value)
  } catch {
    return false
  }
}
