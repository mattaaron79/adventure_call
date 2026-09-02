import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ROLE_RULES,
  decoratorHead,
  isTestPath,
  matchRole,
  type RoleRule,
} from './roles'

/** The three fields {@link matchRole} actually reads off a symbol. */
function sym(
  name: string,
  decorators: string[] = [],
  file_path = 'src/app/thing.py',
): { name: string; file_path: string; decorators: string[] } {
  return { name, file_path, decorators }
}

describe('decoratorHead', () => {
  it('strips the @ from a plain decorator', () => {
    expect(decoratorHead('@property')).toBe('property')
  })

  it('keeps the dotted path', () => {
    expect(decoratorHead('@pytest.fixture')).toBe('pytest.fixture')
  })

  it('drops call arguments', () => {
    expect(decoratorHead('@on(Button.Pressed, "#allow")')).toBe('on')
    expect(decoratorHead('@app.route("/health")')).toBe('app.route')
  })

  it('drops arguments that run over several lines', () => {
    // The exporter stores decorators verbatim, newlines and all.
    const decorator = '@metric(\n  "n_gram_bleed",\n  summary="fraction repeated",\n)'
    expect(decoratorHead(decorator)).toBe('metric')
  })
})

describe('matchRole', () => {
  it('matches a decorator regardless of its arguments', () => {
    expect(matchRole(sym('handle', ['@on(Button.Pressed, "#allow")']))?.role).toBe('handler')
    expect(matchRole(sym('handle', ['@on(Input.Submitted)']))?.role).toBe('handler')
  })

  it('matches a dotted decorator', () => {
    expect(matchRole(sym('client', ['@pytest.fixture']))?.role).toBe('fixture')
  })

  it('matches the bare final segment of a dotted rule, for `from x import y`', () => {
    expect(matchRole(sym('client', ['@fixture']))?.role).toBe('fixture')
  })

  it('does not match a bare rule against a dotted decorator', () => {
    // 'on' is a bare rule; something else's `.on` is not a Textual handler.
    expect(matchRole(sym('handle', ['@scheduler.on']))).toBeNull()
  })

  it('returns null for a decorator nothing knows about', () => {
    expect(matchRole(sym('measure', ['@metric("bleed")']))).toBeNull()
  })

  it('does NOT rescue @staticmethod or @classmethod', () => {
    // They change binding, not who calls: a static method with no callers is
    // as unused as any other function.
    expect(matchRole(sym('helper', ['@staticmethod']))).toBeNull()
    expect(matchRole(sym('build', ['@classmethod']))).toBeNull()
  })

  it('recognises a test function by name and path together', () => {
    expect(matchRole(sym('test_thing', [], 'tests/test_thing.py'))?.role).toBe('test')
  })

  it('does not call a test-named function in source a test', () => {
    // Both halves of the rule have to hold; a `test_` helper shipped in the
    // library is not collected by anything.
    expect(matchRole(sym('test_connection', [], 'src/app/health.py'))).toBeNull()
  })

  it('recognises the dunder protocol, which the language calls itself', () => {
    expect(matchRole(sym('__enter__'))?.role).toBe('dunder')
    expect(matchRole(sym('__repr__'))?.role).toBe('dunder')
  })

  it('does not mistake a private helper for a dunder', () => {
    expect(matchRole(sym('_helper'))).toBeNull()
    expect(matchRole(sym('__private'))).toBeNull()
  })

  it('reports the evidence for the match', () => {
    expect(matchRole(sym('client', ['@pytest.fixture']))?.reason).toBe('decorator @pytest.fixture')
    expect(matchRole(sym('test_x', [], 'tests/test_x.py'))?.reason).toContain('name matches')
  })

  it('takes the first matching rule, so order is the priority', () => {
    const rules: RoleRule[] = [
      { role: 'first', decorator: 'property' },
      { role: 'second', decorator: 'property' },
    ]
    expect(matchRole(sym('x', ['@property']), rules)?.role).toBe('first')
  })

  it('treats an invalid regex in a rule as non-matching rather than throwing', () => {
    // The rule list is user-editable data; one typo must not take down the
    // whole classification.
    const rules: RoleRule[] = [{ role: 'broken', name: '([' }]
    expect(() => matchRole(sym('anything'), rules)).not.toThrow()
    expect(matchRole(sym('anything'), rules)).toBeNull()
  })

  it('ships defaults that name a role for every rule', () => {
    for (const rule of DEFAULT_ROLE_RULES) {
      expect(rule.role).not.toBe('')
      expect(rule.decorator ?? rule.name ?? rule.file).toBeDefined()
    }
  })
})


describe('the test-file rule and Django layouts (tic-f9f7)', () => {
  const test = (name: string, file: string) => matchRole(sym(name, [], file))

  it('still matches the pytest layouts it was tuned on', () => {
    expect(test('test_login', 'tests/test_auth.py')?.role).toBe('test')
    expect(test('test_login', 'src/test_auth.py')?.role).toBe('test')
    expect(test('test_login', 'src/auth_test.py')?.role).toBe('test')
    expect(test('test_login', 'test/thing.py')?.role).toBe('test')
  })

  it("matches Django's single tests.py per app, which it used to miss entirely", () => {
    // The whole reason this ticket exists: on ../hypermenu the `test` role
    // rescued ZERO callables, against 982 on ../carnot, because Django puts an
    // app's tests in one `tests.py` beside the code.
    expect(test('test_menu_saves', 'platform/menus/tests.py')?.role).toBe('test')
    expect(test('test_menu_saves', 'platform/menus/test.py')?.role).toBe('test')
  })

  it('matches a HYPHENATED version suffix, which is what is on disk', () => {
    // ../hypermenu keeps `tests-v1.py` beside `tests.py`.  The module id
    // normalises the hyphen to `_`, but a rule's `file` is matched against the
    // file PATH, which does not -- assuming either separator alone silently
    // costs the rule half its matches.
    expect(test('test_menu_saves', 'platform/menus/tests-v1.py')?.role).toBe('test')
    expect(test('test_menu_saves', 'platform/menus/tests_v1.py')?.role).toBe('test')
    expect(test('test_menu_saves', 'platform/menus/tests-v12.py')?.role).toBe('test')
  })

  it('does not turn every file whose name contains "test" into a test file', () => {
    // Every alternative is anchored to a path segment.
    expect(test('test_thing', 'src/latest.py')).toBeNull()
    expect(test('test_thing', 'src/contest.py')).toBeNull()
    expect(test('test_thing', 'src/protests.py')).toBeNull()
    expect(test('test_thing', 'src/tests_helper.py')).toBeNull()
  })

  it('classifies a TestCase method, once the file rule lets the name rule see it', () => {
    // The name rule `^test_` always would have matched; it never got the
    // chance, because the file rule ran first and failed.
    expect(test('test_multi_location', 'platform/menus/tests.py')?.role).toBe('test')
  })

  it("knows unittest's camelCase fixtures as well as pytest's", () => {
    for (const name of ['setUp', 'tearDown', 'setUpClass', 'tearDownClass', 'setUpModule']) {
      expect(matchRole(sym(name, [], 'platform/menus/tests.py'))?.role).toBe('fixture')
    }
    expect(matchRole(sym('setup_module', [], 'tests/test_x.py'))?.role).toBe('fixture')
  })

  it('does not rescue a setUp that is not in a test file', () => {
    // A method called setUp in production code is production code.
    expect(matchRole(sym('setUp', [], 'src/app/wizard.py'))).toBeNull()
  })

  it('leaves the rescue count on a pytest codebase exactly where it was', () => {
    // Guarding against the other failure: a rule loose enough to fix Django by
    // quietly relabelling things elsewhere.  Measured on ../carnot the new
    // alternative changes nothing at all -- 1107 rescued before and after.
    expect(test('helper', 'src/carnot/kernel/registry.py')).toBeNull()
    expect(test('run', 'src/carnot/plugins/tools/screen_capture.py')).toBeNull()
  })
})

describe('isTestPath agrees with the rule it is derived from (tic-f9f7)', () => {
  it('answers the same for every shape the rule accepts', () => {
    // One definition, two callers: the role map and tic-1ecc's "are all this
    // function's callers tests?".  They must not drift.
    for (const path of [
      'tests/test_auth.py',
      'src/test_auth.py',
      'src/auth_test.py',
      'platform/menus/tests.py',
      'platform/menus/tests-v1.py',
    ]) {
      expect(isTestPath(path)).toBe(true)
      expect(matchRole(sym('test_x', [], path))?.role).toBe('test')
    }
    for (const path of ['src/latest.py', 'src/app/thing.py']) {
      expect(isTestPath(path)).toBe(false)
      expect(matchRole(sym('test_x', [], path))).toBeNull()
    }
  })
})
