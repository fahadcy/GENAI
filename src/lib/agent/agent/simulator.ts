/**
 * A scripted "model" that walks a fixed playbook and writes its report only
 * from evidence labels. It lets the whole agent run, be demonstrated and be
 * tested with no API key. Runs are stored with simulated: true.
 */
import type { Message, ModelClient, ModelTurn, ToolSpec } from './models';

const call = (name: string, args: unknown): ModelTurn => ({ text: '', toolCalls: [{ id: `sim_${name}_${Math.random().toString(36).slice(2, 8)}`, name, args }], usage: { input: 0, output: 0 } });

function toolResults(messages: Message[]) {
  return messages.filter((m): m is Extract<Message, { role: 'tool' }> => m.role === 'tool').map(m => {
    const data = m.content.match(/<data>\n([\s\S]*?)\n<\/data>/)?.[1];
    let parsed: any = null; try { parsed = data ? JSON.parse(data) : null; } catch { /* truncated */ }
    const evidence = [...m.content.matchAll(/^(E\d+): (.+?)(?: \(https?:[^)]*\))?$/gm)].map(x => ({ id: x[1]!, label: x[2]! }));
    const summary = m.content.replace(/<tool_result[^>]*>\n?/, '').split(/\n<(data|evidence)>/)[0]!.trim();
    return { name: m.name, data: parsed, evidence, summary, error: m.content.startsWith('Error') };
  });
}

export class SimulatedModel implements ModelClient {
  readonly id = 'simulator';
  readonly simulated = true;
  async complete(messages: Message[], tools: ToolSpec[]): Promise<ModelTurn> {
    const user = messages.find(m => m.role === 'user')?.content ?? '';
    const goal = user.match(/\[goal:(\w+)\]/)?.[1] ?? 'daily_brief';
    const done = toolResults(messages);
    const has = (n: string) => done.some(d => d.name === n);
    const avail = new Set(tools.map(t => t.name));
    const can = (n: string) => avail.has(n) && !has(n);

    if (goal === 'ask' && can('pipeline_insights')) return call('pipeline_insights', { days: 90 });
    if (goal === 'daily_brief' || goal === 'grow') {
      if (can('pipeline_insights')) return call('pipeline_insights', { days: 90 });
      const stale = done.find(d => d.name === 'pipeline_insights')?.data?.insights?.find((x: any) => x.action?.kind === 'tasks_for_stale' && x.severity === 'act');
      if (stale && can('add_followup_tasks')) return call('add_followup_tasks', { stage: stale.action.stage, reason: 'Lead has gone 14+ days without contact; a short check-in keeps it warm.' });
    }
    if (goal === 'find_leads' || goal === 'grow') {
      if (can('find_leads')) return call('find_leads', { limit: 10, minScore: 55 });
      const leads = (done.find(d => d.name === 'find_leads')?.data?.leads ?? []).filter((l: any) => l.score >= 60);
      if (leads.length && can('add_leads_to_crm')) return call('add_leads_to_crm', { company_numbers: leads.map((l: any) => l.company_number) });
    }
    if (goal === 'outreach' || goal === 'grow') {
      if (can('send_outreach')) return call('send_outreach', {});
    }
    return { text: this.report(goal, done), toolCalls: [], usage: { input: 0, output: 0 } };
  }

  private report(goal: string, done: ReturnType<typeof toolResults>): string {
    const head: Record<string, string> = { daily_brief: 'Daily brief', find_leads: 'New leads', outreach: 'Outreach', grow: 'Growth run', ask: 'Answer (from the pipeline; a language model would answer your exact question)' };
    const lines = [`**${head[goal] ?? 'Report'}** (simulated run: no language model was used)`, ''];
    for (const d of done) {
      if (d.error) { lines.push(`- ${d.name} could not run: ${d.summary.replace(/^Error[^:]*: /, '').replace(/\d/g, '#')}`); continue; }
      if (!d.evidence.length) { lines.push(`- ${d.summary.split('\n')[0]!.replace(/[^.]*\d[^.]*\.?/g, '').trim() || d.name + ' had nothing to report.'}`); continue; }
      for (const e of d.evidence.slice(0, 8)) lines.push(`- ${e.label} [${e.id}]`);
      if (d.evidence.length > 8) lines.push(`- …and more in the run details.`);
    }
    return lines.join('\n');
  }
}
