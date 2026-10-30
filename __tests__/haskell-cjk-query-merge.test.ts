import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { flowTokens, resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';
import { exploreQueryTokens, ToolHandler } from '../src/mcp/tools';

describe('CJK query rules with indexed Haskell identifiers', () => {
  let root: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-haskell-cjk-'));
    fs.writeFileSync(path.join(root, 'Main.hs'), [
      'module Main where',
      '函数 value = λ value',
      'λ value = на value',
      'на value = 类 value',
      '类 value = finish value',
      'get用户 value = 类 value',
      'finish value = value',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'other.ts'), [
      'export function μ() { return 1; }',
      'export function 的() { return 2; }',
      'export class NavMeshAgent {}',
    ].join('\n'));
    cg = CodeGraph.initSync(root);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    handler?.closeAll();
    cg?.destroy();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('requires exact Haskell evidence for short Unicode names, even in a mixed project', () => {
    for (const tokenize of [flowTokens, exploreQueryTokens]) {
      expect(tokenize('函数 λ finish')).toEqual(['函数', 'finish']);
      expect(tokenize('函数 λ finish', cg)).toEqual(['函数', 'λ', 'finish']);
      expect(tokenize('π μ из 的 λ на 类 finish', cg)).toEqual(['λ', 'на', '类', 'finish']);
    }
  });

  it('preserves an indexed mixed-script Haskell name while splitting ordinary CJK prose', () => {
    for (const tokenize of [flowTokens, exploreQueryTokens]) {
      expect(tokenize('get用户 NavMeshAgent类型 finish', cg))
        .toEqual(['get用户', 'NavMeshAgent', '类型', 'finish']);
      expect(tokenize('https://get用户 get用户;finish Main.函数', cg)).toEqual(['Main.函数']);
    }
  });

  it('keeps ordinary Unicode and numeric qualified-name forms from main', () => {
    for (const tokenize of [flowTokens, exploreQueryTokens]) {
      expect(tokenize('ʰello Ⅳalue pkg.2d pkg::123'))
        .toEqual(['ʰello', 'Ⅳalue', 'pkg.2d', 'pkg::123']);
      expect(tokenize("Module.'invalid 'invalid foo;bar")).toEqual([]);
    }
  });

  it.each(['Main.get用户', 'Main::get用户'])('keeps the qualifier on %s through flow and explore', async (name) => {
    for (const tokenize of [flowTokens, exploreQueryTokens]) {
      expect(tokenize(`${name} finish`, cg)).toEqual([name, 'finish']);
    }
    expect(resolveNamedSymbolFlow(cg, `${name} finish`).chains[0]?.steps.map(({ node }) => node.name))
      .toEqual(['get用户', '类', 'finish']);
    const response = await handler.execute('codegraph_explore', { query: `${name} finish` });
    expect(response.isError).toBeFalsy();
    expect(response.content?.[0]?.text).toMatch(/^\*\*Flow/);
    expect(response.content?.[0]?.text).toContain('get用户 value = 类 value');
  });

  it('connects short Unicode Haskell names through the real graph and explore tool', async () => {
    const flow = resolveNamedSymbolFlow(cg, 'λ на 类 finish');
    expect(flow.chains[0]?.steps.map(({ node }) => node.name)).toEqual(['λ', 'на', '类', 'finish']);
    const response = await handler.execute('codegraph_explore', { query: 'λ на 类 finish' });
    expect(response.isError).toBeFalsy();
    const text = response.content?.[0]?.text ?? '';
    expect(text).toMatch(/^\*\*Flow/);
    expect(text).toContain('λ value = на value');
    expect(text).toContain('类 value = finish value');
  });
});
