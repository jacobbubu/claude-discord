import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../protocol/version.ts'
import type { CcToolTraceMsg } from '../../protocol/schema.ts'
import {
  clampDescription,
  jsonToYaml,
  renderTraceContent,
} from '../trace-formatter.ts'

function trace(overrides: Partial<CcToolTraceMsg> = {}): CcToolTraceMsg {
  return {
    type: 'cc_tool_trace',
    v: PROTOCOL_VERSION,
    tool_name: 'Bash',
    tool_input: '{}',
    tool_response: '',
    status: 'ok',
    cwd: '/work',
    ...overrides,
  }
}

describe('renderTraceContent (deltas §40)', () => {
  describe('Bash', () => {
    it('splits command / stdout / stderr; adds Status + Exit + Intent fields', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({
            command: 'git status -s',
            description: 'check working tree',
          }),
          tool_response: JSON.stringify({
            stdout: ' M src/foo.ts',
            stderr: '',
            exitCode: 0,
          }),
          status: 'ok',
        }),
      )
      expect(r.description).toContain('**Command**')
      expect(r.description).toContain('```bash\ngit status -s\n```')
      expect(r.description).toContain('**stdout**')
      expect(r.description).toContain('```text\n M src/foo.ts\n```')
      expect(r.description).not.toContain('**stderr**') // omitted when empty
      const names = (r.fields ?? []).map(f => f.name)
      expect(names).toEqual(['Status', 'Exit', 'Intent'])
      expect(r.fields![0]!.value).toBe('✅ ok')
      expect(r.fields![1]!.value).toBe('`0`')
      expect(r.fields![2]!.value).toBe('check working tree')
    })

    it('error status → ❌ Status', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'false' }),
          tool_response: JSON.stringify({ stdout: '', stderr: 'oops', exitCode: 1 }),
          status: 'error',
        }),
      )
      const status = r.fields!.find(f => f.name === 'Status')!
      expect(status.value).toBe('❌ error')
      expect(r.description).toContain('**stderr**')
      expect(r.description).toContain('```text\noops\n```')
    })

    it('falls back to raw response when output is not JSON-shaped', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'echo hi' }),
          tool_response: 'hi',
          status: 'ok',
        }),
      )
      expect(r.description).toContain('```text\nhi\n```')
    })

    it('§40-fix: unwraps generic envelope when Bash shape keys are missing', () => {
      // E.g. response arrived wrapped as `{content: [{type, text}]}` instead
      // of `{stdout, stderr, exitCode}`. Should still extract clean stdout
      // instead of dumping the JSON envelope.
      const r = renderTraceContent(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'ls' }),
          tool_response: JSON.stringify({
            content: [{ type: 'text', text: 'a.ts\nb.ts\n' }],
          }),
          status: 'ok',
        }),
      )
      expect(r.description).toContain('```text\na.ts\nb.ts')
      expect(r.description).not.toContain('"content"')
    })
  })

  describe('Read', () => {
    it('shows file content; adds File + Range fields', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/x.ts', offset: 10, limit: 5 }),
          tool_response: '     1\tline one\n     2\tline two\n',
        }),
      )
      expect(r.description).toContain('```text\n     1\tline one')
      const names = (r.fields ?? []).map(f => f.name)
      expect(names).toContain('File')
      expect(names).toContain('Range')
      const file = r.fields!.find(f => f.name === 'File')!
      expect(file.value).toBe('`/src/x.ts`')
      const range = r.fields!.find(f => f.name === 'Range')!
      expect(range.value).toBe('10–14')
    })

    it('§40-fix: unwraps CC structured response { type, file: { content } }', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/x.ts' }),
          tool_response: JSON.stringify({
            type: 'text',
            file: { filePath: '/src/x.ts', content: 'line one\nline two\n' },
          }),
        }),
      )
      expect(r.description).toContain('```text\nline one\nline two')
      // Should NOT leak the wrapper fields:
      expect(r.description).not.toContain('"filePath"')
      expect(r.description).not.toContain('"type":"text"')
    })

    it('§40-fix: unwraps CC structured response { type, file: [{ content }] } (array shape)', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/y.ts' }),
          tool_response: JSON.stringify({
            type: 'text',
            file: [{ filePath: '/src/y.ts', content: 'array shape content\n' }],
          }),
        }),
      )
      expect(r.description).toContain('```text\narray shape content')
    })

    it('§40-fix: falls back to raw string when shape is unknown', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/z.ts' }),
          tool_response: 'plain string content',
        }),
      )
      expect(r.description).toContain('```text\nplain string content')
    })

    it('§40-fix: unwraps Anthropic content-array shape { content: [{ type, text }] }', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/a.ts' }),
          tool_response: JSON.stringify({
            content: [{ type: 'text', text: 'array envelope body' }],
          }),
        }),
      )
      expect(r.description).toContain('array envelope body')
      expect(r.description).not.toContain('"type"')
    })
  })

  describe('Grep', () => {
    it('adds Pattern + Path fields; body has hits in text fence', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Grep',
          tool_input: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
          tool_response: 'src/a.ts:12: // TODO refactor',
        }),
      )
      const f = (r.fields ?? []).map(x => `${x.name}=${x.value}`)
      expect(f).toContain('Pattern=`TODO`')
      expect(f).toContain('Path=`src/`')
      expect(r.description).toContain('```text\nsrc/a.ts:12: // TODO refactor\n```')
    })

    it('unwraps {type:"text", text:"..."} envelope', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Grep',
          tool_input: JSON.stringify({ pattern: 'foo' }),
          tool_response: JSON.stringify({ type: 'text', text: 'a.ts:1:foo' }),
        }),
      )
      expect(r.description).toContain('a.ts:1:foo')
      expect(r.description).not.toContain('"type"')
    })
  })

  describe('Glob', () => {
    it('adds Pattern + Path fields', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Glob',
          tool_input: JSON.stringify({ pattern: '**/*.ts', path: 'src' }),
          tool_response: 'src/a.ts\nsrc/b.ts',
        }),
      )
      const names = (r.fields ?? []).map(f => f.name)
      expect(names).toEqual(['Pattern', 'Path'])
    })
  })

  describe('WebFetch / WebSearch', () => {
    it('WebFetch → URL field', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'WebFetch',
          tool_input: JSON.stringify({ url: 'https://example.com' }),
          tool_response: 'summary text',
        }),
      )
      expect(r.fields![0]).toEqual({ name: 'URL', value: 'https://example.com', inline: false })
    })

    it('WebSearch → Query field', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'WebSearch',
          tool_input: JSON.stringify({ query: 'discord embed limits' }),
          tool_response: '...',
        }),
      )
      expect(r.fields![0]).toEqual({ name: 'Query', value: '`discord embed limits`', inline: true })
    })
  })

  describe('Edit / MultiEdit / Write', () => {
    it('Edit → File field + YAML body (text fallback for §39 image)', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'Edit',
          tool_input: JSON.stringify({
            file_path: '/src/x.ts',
            old_string: 'a',
            new_string: 'b',
          }),
          tool_response: 'ok',
        }),
      )
      expect(r.fields![0]).toEqual({ name: 'File', value: '`/src/x.ts`', inline: true })
      expect(r.description).toContain('**Edit**')
      expect(r.description).toContain('```yaml')
      expect(r.description).toContain('file_path: /src/x.ts')
    })
  })

  describe('Unknown tool', () => {
    it('falls back to YAML dump of input + output', () => {
      const r = renderTraceContent(
        trace({
          tool_name: 'SomethingNew',
          tool_input: JSON.stringify({ a: 1, b: 'foo' }),
          tool_response: 'result',
        }),
      )
      expect(r.description).toContain('**Input**')
      expect(r.description).toContain('```yaml')
      expect(r.description).toContain('a: 1')
      expect(r.description).toContain('b: foo')
      expect(r.description).toContain('**Output**')
      expect(r.description).toContain('result')
      expect(r.fields).toBeUndefined()
    })
  })
})

describe('jsonToYaml (deltas §40)', () => {
  it('renders flat objects as key: value lines', () => {
    const y = jsonToYaml({ a: 1, b: 'hello', c: true, d: null })
    expect(y).toBe('a: 1\nb: hello\nc: true\nd: null')
  })

  it('renders nested objects with indentation', () => {
    const y = jsonToYaml({ outer: { inner: 'x', n: 2 } })
    expect(y).toBe('outer:\n  inner: x\n  n: 2')
  })

  it('renders arrays of scalars with - prefix', () => {
    const y = jsonToYaml({ list: ['a', 'b', 'c'] })
    expect(y).toBe('list:\n  - a\n  - b\n  - c')
  })

  it('renders empty array as [] and empty object as {}', () => {
    expect(jsonToYaml({ x: [], y: {} })).toBe('x: []\ny: {}')
  })

  it('renders multi-line string as block scalar |-', () => {
    const y = jsonToYaml({ text: 'line1\nline2\nline3' })
    expect(y).toContain('text: |-')
    expect(y).toContain('  line1')
    expect(y).toContain('  line2')
    expect(y).toContain('  line3')
  })

  it('quotes strings that look like booleans / numbers / null', () => {
    expect(jsonToYaml('true')).toBe('"true"')
    expect(jsonToYaml('42')).toBe('"42"')
    expect(jsonToYaml('null')).toBe('"null"')
  })

  it('quotes strings with colon-space (would be parsed as key)', () => {
    expect(jsonToYaml('foo: bar')).toBe('"foo: bar"')
  })

  it('leaves plain strings bare', () => {
    expect(jsonToYaml('plain words here')).toBe('plain words here')
  })

  it('handles array of objects with sub-indentation', () => {
    const y = jsonToYaml({ items: [{ id: 1 }, { id: 2 }] })
    expect(y).toContain('items:')
    expect(y).toContain('- id: 1')
    expect(y).toContain('- id: 2')
  })
})

describe('clampDescription (deltas §40)', () => {
  it('passes through when under max', () => {
    expect(clampDescription('hello', 100)).toBe('hello')
  })

  it('truncates with marker when over max', () => {
    const s = 'x'.repeat(200)
    const out = clampDescription(s, 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toContain('truncated')
  })

  it('closes an unterminated fence after truncation', () => {
    // Open a ``` early then fill so truncation cuts inside the fence body.
    const s = '```text\n' + 'y'.repeat(500)
    const out = clampDescription(s, 100)
    // The kept prefix has 1 opening ``` → close must be appended
    expect(out).toMatch(/```\n?…\(truncated/)
  })

  it('does not add stray closer when fences are balanced before cut', () => {
    const s = '```text\nhi\n```\n' + 'pad'.repeat(200)
    const out = clampDescription(s, 100)
    // Fences are balanced in the prefix portion — no extra ``` should be added
    // beyond what is already in the prefix. We assert by counting that there
    // aren't 3 separate ``` runs in the result.
    const fences = (out.match(/```/g) ?? []).length
    expect(fences).toBe(2)
  })
})
