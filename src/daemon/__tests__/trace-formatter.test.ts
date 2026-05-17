import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '../../protocol/version.ts'
import type { CcToolTraceMsg } from '../../protocol/schema.ts'
import {
  clampDescription,
  DIFF_IMAGE_NAME,
  extractToolText,
  jsonToYaml,
  renderTrace,
  toolIcon,
  type EmbedField,
  type TraceEmbedSpec,
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

const findEmbed = (embeds: TraceEmbedSpec[], title: string): TraceEmbedSpec | undefined =>
  embeds.find(e => e.title?.includes(title))

const fieldByName = (fields: EmbedField[] | undefined, name: string): EmbedField | undefined =>
  fields?.find(f => f.name === name)

describe('renderTrace §43 — multi-embed per tool', () => {
  describe('Bash', () => {
    it('produces meta + Command + stdout (no stderr) when stderr empty', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({
            command: 'git status -s',
            description: 'check working tree',
          }),
          tool_response: JSON.stringify({
            stdout: ' M src/foo.ts',
            stderr: '',
            interrupted: false,
          }),
          status: 'ok',
        }),
      )
      // 3 embeds: meta + Command + stdout (stderr empty → omitted)
      expect(r.embeds.map(e => e.title)).toEqual(['💻 Bash', 'Command', 'stdout'])

      const meta = r.embeds[0]!
      expect(meta.fields).toBeDefined()
      const names = meta.fields!.map(f => f.name)
      expect(names).toEqual(['Status', 'Intent'])
      expect(fieldByName(meta.fields, 'Status')!.value).toBe('✅ ok')
      expect(fieldByName(meta.fields, 'Intent')!.value).toBe('check working tree')

      expect(r.embeds[1]!.description).toContain('```bash\ngit status -s\n```')
      expect(r.embeds[2]!.description).toContain('```text\n M src/foo.ts\n```')
    })

    it('error status → ❌ on Status field; stderr present → 4th embed with red color', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'false' }),
          tool_response: JSON.stringify({ stdout: '', stderr: 'oops' }),
          status: 'error',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['💻 Bash', 'Command', 'stderr'])
      expect(fieldByName(r.embeds[0]!.fields, 'Status')!.value).toBe('❌ error')
      // meta + Command share the error color; stderr explicitly red.
      const stderr = findEmbed(r.embeds, 'stderr')!
      expect(stderr.color).toBe(0xed4245)
      expect(stderr.description).toContain('```text\noops\n```')
    })

    it('interrupted: true → Interrupted field', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'sleep 100' }),
          tool_response: JSON.stringify({
            stdout: '',
            stderr: '',
            interrupted: true,
          }),
          status: 'error',
        }),
      )
      const meta = r.embeds[0]!
      const names = meta.fields!.map(f => f.name)
      expect(names).toContain('Interrupted')
      expect(fieldByName(meta.fields, 'Interrupted')!.value).toBe('⏸ yes')
    })

    it('falls back to raw response (envelope) when shape lacks stdout key', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'ls' }),
          tool_response: JSON.stringify({ content: [{ type: 'text', text: 'a.ts\nb.ts' }] }),
          status: 'ok',
        }),
      )
      const stdout = findEmbed(r.embeds, 'stdout')!
      expect(stdout.description).toContain('```text\na.ts\nb.ts')
      expect(stdout.description).not.toContain('"content"')
    })
  })

  describe('Read', () => {
    it('meta (File + Range) + Content; unwraps CC structured response', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Read',
          tool_input: JSON.stringify({ file_path: '/src/x.ts', offset: 10, limit: 5 }),
          tool_response: JSON.stringify({
            type: 'text',
            file: { filePath: '/src/x.ts', content: 'line one\nline two\n' },
          }),
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['📖 Read', 'Content'])
      const meta = r.embeds[0]!
      expect(fieldByName(meta.fields, 'File')!.value).toBe('`/src/x.ts`')
      expect(fieldByName(meta.fields, 'Range')!.value).toBe('10–14')
      // Body shows raw file content, not the wrapper JSON.
      expect(r.embeds[1]!.description).toContain('line one')
      expect(r.embeds[1]!.description).not.toContain('"filePath"')
    })
  })

  describe('Grep / Glob', () => {
    it('Grep: meta (Pattern + Path) + Hits', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Grep',
          tool_input: JSON.stringify({ pattern: 'TODO', path: 'src/' }),
          tool_response: 'src/a.ts:12: // TODO refactor',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['🔍 Grep', 'Hits'])
      expect(fieldByName(r.embeds[0]!.fields, 'Pattern')!.value).toBe('`TODO`')
      expect(fieldByName(r.embeds[0]!.fields, 'Path')!.value).toBe('`src/`')
      expect(r.embeds[1]!.description).toContain('src/a.ts:12: // TODO refactor')
    })

    it('Glob: meta (Pattern + Path) + Matches', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Glob',
          tool_input: JSON.stringify({ pattern: '**/*.ts', path: 'src' }),
          tool_response: 'src/a.ts\nsrc/b.ts',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['📁 Glob', 'Matches'])
    })
  })

  describe('WebFetch / WebSearch', () => {
    it('WebFetch: meta (URL) + Body', () => {
      const r = renderTrace(
        trace({
          tool_name: 'WebFetch',
          tool_input: JSON.stringify({ url: 'https://example.com' }),
          tool_response: 'summary text',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['🌐 WebFetch', 'Body'])
      const url = fieldByName(r.embeds[0]!.fields, 'URL')!
      expect(url.value).toBe('https://example.com')
      expect(url.inline).toBe(false)
    })

    it('WebSearch: meta (Query) + Results', () => {
      const r = renderTrace(
        trace({
          tool_name: 'WebSearch',
          tool_input: JSON.stringify({ query: 'discord embed limits' }),
          tool_response: '...',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['🔎 WebSearch', 'Results'])
      expect(fieldByName(r.embeds[0]!.fields, 'Query')!.value).toBe('`discord embed limits`')
    })
  })

  describe('Edit / MultiEdit / Write', () => {
    it('Edit: meta (File) + Diff body with imageAttachment for §39 PNG', () => {
      const r = renderTrace(
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
      expect(r.embeds.map(e => e.title)).toEqual(['✏️ Edit', 'Diff'])
      expect(fieldByName(r.embeds[0]!.fields, 'File')!.value).toBe('`/src/x.ts`')
      // Body embed flags itself as the silicon PNG target.
      expect(r.embeds[1]!.imageAttachment).toBe(DIFF_IMAGE_NAME)
      expect(r.embeds[1]!.description).toContain('```yaml')
      expect(r.embeds[1]!.description).toContain('file_path: /src/x.ts')
    })

    it('Write: title says Write but layout matches Edit', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Write',
          tool_input: JSON.stringify({ file_path: '/src/new.ts', content: 'hello' }),
          tool_response: 'ok',
        }),
      )
      expect(r.embeds[0]!.title).toBe('📝 Write')
      expect(r.embeds[1]!.imageAttachment).toBe(DIFF_IMAGE_NAME)
    })
  })

  describe('Unknown tool', () => {
    it('falls back to meta + Input + Output YAML', () => {
      const r = renderTrace(
        trace({
          tool_name: 'SomethingNew',
          tool_input: JSON.stringify({ a: 1, b: 'foo' }),
          tool_response: 'result',
        }),
      )
      expect(r.embeds.map(e => e.title)).toEqual(['🔧 SomethingNew', 'Input', 'Output'])
      expect(r.embeds[1]!.description).toContain('a: 1')
      expect(r.embeds[1]!.description).toContain('b: foo')
      expect(r.embeds[2]!.description).toContain('result')
    })
  })

  describe('color semantics', () => {
    it('status=ok → all non-error embeds use blurple', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'echo hi' }),
          tool_response: JSON.stringify({ stdout: 'hi', stderr: '' }),
          status: 'ok',
        }),
      )
      for (const e of r.embeds) {
        if (e.color != null) expect(e.color).toBe(0x5865f2)
      }
    })

    it('status=error → meta + Command red; stderr embed always red', () => {
      const r = renderTrace(
        trace({
          tool_name: 'Bash',
          tool_input: JSON.stringify({ command: 'false' }),
          tool_response: JSON.stringify({ stdout: '', stderr: 'boom' }),
          status: 'error',
        }),
      )
      expect(r.embeds[0]!.color).toBe(0xed4245)
      expect(findEmbed(r.embeds, 'stderr')!.color).toBe(0xed4245)
    })
  })
})

describe('toolIcon (§40-fix)', () => {
  it('returns per-tool emojis for known tools', () => {
    expect(toolIcon('Bash')).toBe('💻')
    expect(toolIcon('Read')).toBe('📖')
    expect(toolIcon('Grep')).toBe('🔍')
    expect(toolIcon('Glob')).toBe('📁')
    expect(toolIcon('Edit')).toBe('✏️')
    expect(toolIcon('MultiEdit')).toBe('✏️')
    expect(toolIcon('Write')).toBe('📝')
    expect(toolIcon('WebFetch')).toBe('🌐')
    expect(toolIcon('WebSearch')).toBe('🔎')
  })

  it('falls back to wrench for unknown tools', () => {
    expect(toolIcon('SomeUnknownTool')).toBe('🔧')
  })
})

describe('extractToolText (§40-fix)', () => {
  it('returns raw response when not JSON', () => {
    expect(extractToolText('plain text')).toBe('plain text')
  })

  it('unwraps {file: {content}}', () => {
    expect(
      extractToolText(JSON.stringify({ type: 'text', file: { filePath: '/x', content: 'body' } })),
    ).toBe('body')
  })

  it('unwraps {file: [{content}]}', () => {
    expect(
      extractToolText(JSON.stringify({ type: 'text', file: [{ filePath: '/x', content: 'arr' }] })),
    ).toBe('arr')
  })

  it('unwraps {type, text}', () => {
    expect(extractToolText(JSON.stringify({ type: 'text', text: 'inner' }))).toBe('inner')
  })

  it('unwraps {content: [{type, text}]}', () => {
    expect(extractToolText(JSON.stringify({ content: [{ type: 'text', text: 'env' }] }))).toBe('env')
  })
})

describe('jsonToYaml (§40)', () => {
  it('renders flat objects', () => {
    expect(jsonToYaml({ a: 1, b: 'hello', c: true, d: null })).toBe('a: 1\nb: hello\nc: true\nd: null')
  })

  it('renders nested objects with indentation', () => {
    expect(jsonToYaml({ outer: { inner: 'x', n: 2 } })).toBe('outer:\n  inner: x\n  n: 2')
  })

  it('renders arrays of scalars with - prefix', () => {
    expect(jsonToYaml({ list: ['a', 'b', 'c'] })).toBe('list:\n  - a\n  - b\n  - c')
  })

  it('multi-line string → block scalar |-', () => {
    const y = jsonToYaml({ text: 'line1\nline2' })
    expect(y).toContain('text: |-')
    expect(y).toContain('  line1')
    expect(y).toContain('  line2')
  })

  it('quotes strings that look like booleans / numbers', () => {
    expect(jsonToYaml('true')).toBe('"true"')
    expect(jsonToYaml('42')).toBe('"42"')
  })

  it('quotes strings containing colon-space', () => {
    expect(jsonToYaml('foo: bar')).toBe('"foo: bar"')
  })

  it('renders array of objects with hanging indent', () => {
    const y = jsonToYaml({ items: [{ id: 1 }, { id: 2 }] })
    expect(y).toContain('- id: 1')
    expect(y).toContain('- id: 2')
  })
})

describe('clampDescription (§40)', () => {
  it('passes through when under max', () => {
    expect(clampDescription('hi', 100)).toBe('hi')
  })

  it('appends truncated marker when over max', () => {
    const out = clampDescription('x'.repeat(200), 100)
    expect(out.length).toBeLessThanOrEqual(100)
    expect(out).toContain('truncated')
  })

  it('closes an unterminated fence after truncation', () => {
    const s = '```text\n' + 'y'.repeat(500)
    const out = clampDescription(s, 100)
    expect(out).toMatch(/```\n?…\(truncated/)
  })
})
