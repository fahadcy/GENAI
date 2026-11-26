/**
 * Model adapters behind one interface. Anthropic (Claude) and OpenAI-style
 * chat completions both supported; the simulator (simulator.ts) implements
 * the same interface so everything runs with no key.
 */

export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface ToolCall { id: string; name: string; args: unknown }
export type Message =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export interface ModelTurn { text: string; toolCalls: ToolCall[]; usage: { input: number; output: number } }
export interface ModelClient {
  readonly id: string;           // shown in run reports
  readonly simulated: boolean;
  complete(messages: Message[], tools: ToolSpec[]): Promise<ModelTurn>;
}

export class ModelError extends Error { constructor(msg: string, public status = 0) { super(msg); } }

async function post(f: typeof fetch, url: string, headers: Record<string, string>, body: unknown, retries = 2): Promise<any> {
  for (let a = 0; ; a++) {
    const r = await f(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    if ((r.status === 429 || r.status >= 500) && a < retries) { await new Promise(res => setTimeout(res, 1000 * 2 ** a)); continue; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new ModelError(`Model API ${r.status}: ${j?.error?.message ?? 'error'}`, r.status);
    return j;
  }
}

/** Anthropic Messages API. https://docs.claude.com/en/api/messages */
export class AnthropicModel implements ModelClient {
  readonly simulated = false;
  constructor(private key: string, readonly id: string, private opts: { fetch?: typeof fetch; maxTokens?: number } = {}) {
    if (!key) throw new Error('ANTHROPIC_API_KEY is empty');
  }
  async complete(messages: Message[], tools: ToolSpec[]): Promise<ModelTurn> {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const out: any[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') out.push({ role: 'user', content: m.content });
      else if (m.role === 'assistant') {
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        out.push({ role: 'assistant', content });
      } else {
        const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
        const prev = out[out.length - 1];
        if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content[0]?.type === 'tool_result') prev.content.push(block);
        else out.push({ role: 'user', content: [block] });
      }
    }
    const j = await post(this.opts.fetch ?? fetch, 'https://api.anthropic.com/v1/messages',
      { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
      { model: this.id, max_tokens: this.opts.maxTokens ?? 2048, system, messages: out,
        tools: tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters })) });
    const blocks: any[] = j.content ?? [];
    return {
      text: blocks.filter(b => b.type === 'text').map(b => b.text).join(''),
      toolCalls: blocks.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: b.input })),
      usage: { input: j.usage?.input_tokens ?? 0, output: j.usage?.output_tokens ?? 0 },
    };
  }
}

/** OpenAI-compatible chat completions (OpenAI, Azure OpenAI, or GenAI's existing gateway). */
export class OpenAIModel implements ModelClient {
  readonly simulated = false;
  constructor(private key: string, readonly id: string, private opts: { fetch?: typeof fetch; baseUrl?: string } = {}) {
    if (!key) throw new Error('OPENAI_API_KEY is empty');
    if (!id) throw new Error('Set GENAI_AGENT_MODEL to the OpenAI model id to use');
  }
  async complete(messages: Message[], tools: ToolSpec[]): Promise<ModelTurn> {
    const msgs = messages.map(m => {
      if (m.role === 'assistant') return { role: 'assistant', content: m.content || null,
        ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) } : {}) };
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
      return { role: m.role, content: m.content };
    });
    const j = await post(this.opts.fetch ?? fetch, (this.opts.baseUrl ?? 'https://api.openai.com/v1') + '/chat/completions',
      { Authorization: `Bearer ${this.key}` },
      { model: this.id, messages: msgs, tools: tools.map(t => ({ type: 'function', function: t })), tool_choice: 'auto' });
    const msg = j.choices?.[0]?.message ?? {};
    return {
      text: msg.content ?? '',
      toolCalls: (msg.tool_calls ?? []).map((c: any) => {
        let args: unknown = {};
        try { args = JSON.parse(c.function?.arguments ?? '{}'); } catch { args = { __unparseable: c.function?.arguments }; }
        return { id: c.id, name: c.function?.name, args };
      }),
      usage: { input: j.usage?.prompt_tokens ?? 0, output: j.usage?.completion_tokens ?? 0 },
    };
  }
}
