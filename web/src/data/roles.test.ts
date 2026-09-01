import { describe, expect, it } from 'vitest'
import { DEFAULT_ROLE_RULES, decoratorHead, matchRole, type RoleRule } from './roles'

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
