# Vendored tree-sitter grammars

Most language grammars in codegraph resolve at runtime from the
[`tree-sitter-wasms`](https://www.npmjs.com/package/tree-sitter-wasms) npm
package (see `src/extraction/grammars.ts`). The `.wasm` files in **this**
directory are the exceptions — grammars vendored into the repo because:

- they're missing from `tree-sitter-wasms` (Pascal, Haskell), or
- the version `tree-sitter-wasms` ships is too old / broken (Lua's ABI-13
  build corrupts the shared WASM heap under `web-tree-sitter` 0.25; see the
  inline comment in `grammars.ts` for the full story).

`copy-assets` (run from `npm run build`) ships every `*.wasm` here into
`dist/extraction/wasm/`. **Add a `.wasm` here, the matching token to the
vendored branch in `grammars.ts:174`, and a row to the table below.**

## Vendored grammars

| Grammar | sha256 (first 16) | ABI | Source | Commit | Built with |
|---|---|---|---|---|---|
| `tree-sitter-haskell.wasm` | `d82f63a8c3df7748` | 14 | [tree-sitter/tree-sitter-haskell](https://github.com/tree-sitter/tree-sitter-haskell) | [`0975ef72`](https://github.com/tree-sitter/tree-sitter-haskell/commit/0975ef72fc3c47b530309ca93937d7d143523628) | `tree-sitter build --wasm` (WASI-SDK 29) |
| `tree-sitter-lua.wasm` | `6d95607fc7d78964` | 15 | upstream `tree-sitter-lua` (ABI-15) | TBD on next rebuild | `tree-sitter build --wasm` |
| `tree-sitter-luau.wasm` | `f1647052518f2bdf` | TBD | upstream `tree-sitter-luau` | TBD on next rebuild | `tree-sitter build --wasm` |
| `tree-sitter-pascal.wasm` | `be3634fca99c19f5` | TBD | upstream Pascal grammar | TBD on next rebuild | `tree-sitter build --wasm` |
| `tree-sitter-scala.wasm` | `7945b13e6f9b15b5` | TBD | upstream `tree-sitter-scala` | TBD on next rebuild | `tree-sitter build --wasm` |

The table records compact hash prefixes; run `sha256sum *.wasm` inside this
directory to verify the full hashes. Whenever you re-vendor a grammar, update
the matching row.

## Rebuilding a grammar (the Haskell recipe)

This is the exact path used to produce `tree-sitter-haskell.wasm`. The same
recipe works for any tree-sitter grammar that ships its `grammar.js` /
`parser.c` (almost all do).

```bash
# 1. Tooling (pinned to the version used for the vendored artifact)
npm i -g tree-sitter-cli@0.24.4   # provides the `tree-sitter` binary

# 2. Clone the grammar at a specific commit (pin it!)
git clone https://github.com/tree-sitter/tree-sitter-haskell /tmp/ts-haskell
cd /tmp/ts-haskell
git checkout 0975ef72fc3c47b530309ca93937d7d143523628

# 3. Build the wasm. Downloads WASI-SDK 29 (~113 MB) into
#    ~/.cache/tree-sitter/ on first run; subsequent builds reuse it.
tree-sitter build --wasm

# 4. Vendor it
cp tree-sitter-haskell.wasm <codegraph>/src/extraction/wasm/

# 5. Health-check it against codegraph's multi-grammar runtime
cd <codegraph>
node scripts/add-lang/check-grammar.mjs \
  src/extraction/wasm/tree-sitter-haskell.wasm \
  <some-valid-sample>.hs
# Must print "RESULT: PASS — grammar parses cleanly and reuses safely."
# A FAIL here (e.g. ABI 13 grammars under web-tree-sitter 0.25) means the
# wasm corrupts the shared WASM heap and silently drops nodes on every parse
# after the first — DO NOT ship it.

# 6. Record the sha256 + commit in the table above so future rebuilds are
#    reproducible:
sha256sum src/extraction/wasm/tree-sitter-haskell.wasm
```

### Why not `tree-sitter-wasms`?

Two reasons it can't cover Haskell today:

- The published `tree-sitter-wasms@0.1.13` does not include a haskell build
  (`tar tzf tree-sitter-wasms-0.1.13.tgz | grep haskell` is empty).
- The official `tree-sitter-haskell` npm package ships `grammar.js`,
  `parser.c`, and Node bindings — but **no precompiled `.wasm`**.

If a future `tree-sitter-wasms` adds a healthy haskell grammar, this vendored
copy can be deleted: remove `'haskell'` from the vendored branch in
`grammars.ts` and the row above.
