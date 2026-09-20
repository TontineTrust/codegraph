import { describe, expect, it } from 'vitest';
import { normalizeHaskellReferenceName } from '../src/resolution/import-resolver';

// Compatibility oracle for the previous spelling semantics, including malformed
// input. Its deliberately small inputs keep the old repeated scan inexpensive.
function previousUnwrap(value: string): string {
  let result = value.trim();
  for (;;) {
    if (!result.startsWith('(') || !result.endsWith(')')) return result;
    let depth = 0;
    let whole = true;
    for (let i = 0; i < result.length; i++) {
      if (result[i] === '(') depth++;
      else if (result[i] === ')') depth--;
      if (depth < 0 || (depth === 0 && i < result.length - 1)) {
        whole = false;
        break;
      }
    }
    if (!whole || depth !== 0) return result;
    result = result.slice(1, -1).trim();
  }
}

describe('Haskell reference normalization audit', () => {
  it.each([
    ['((map))', 'map'],
    ['( (\tmap\n) )', 'map'],
    ['(\uFEFF(\u00a0map\u2003)\r\n)', 'map'],
    ['(\u200bmap)', '\u200bmap'],
    ['((( )))', ''],
    ['((foo)(bar))', '(foo)(bar)'],
    ['((foo) (bar))', '(foo) (bar)'],
    ['((foo)) trailing', '((foo)) trailing'],
    ['((foo)', '((foo)'],
    ['(foo))', '(foo))'],
    ['(()())', '()()'],
    ['(map)(map)', '(map)(map)'],
    ['(((Ops.<+>)))', 'Ops::(<+>)'],
    ['((Ops::((:::))))', 'Ops::(:::)'],
    ['((A.B::map))', 'A.B::map'],
    ['(A.B.map)', 'A.B::map'],
    ['(A.B.((<+>)))', 'A.B::(<+>)'],
    ['((<+>))', '<+>'],
  ])('preserves the canonical spelling of %j', (source, expected) => {
    expect(normalizeHaskellReferenceName(source)).toBe(expected);
  });

  it('matches the previous semantics for every short parenthesis/whitespace arrangement', () => {
    const alphabet = ['(', ')', 'x', ' ', '\t'];
    let inputs = [''];
    for (let length = 0; length <= 6; length++) {
      for (const source of inputs) {
        expect(normalizeHaskellReferenceName(source), JSON.stringify(source))
          .toBe(previousUnwrap(source));
      }
      inputs = inputs.flatMap((prefix) => alphabet.map((char) => prefix + char));
    }
  });

  it('normalizes deeply wrapped names without rescanning every enclosing pair', () => {
    const depth = 65_536;
    expect(normalizeHaskellReferenceName('('.repeat(depth) + 'map' + ')'.repeat(depth)))
      .toBe('map');
  });
});
