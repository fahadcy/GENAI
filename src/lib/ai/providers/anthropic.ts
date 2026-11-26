import 'server-only'
import { env } from '@/lib/env'
import type { ProviderComplete } from '../gateway'

/**
 * Anthropic via the REST API directly — keeps the dependency surface small and
 * proves the gateway abstraction holds with a second provider shape.
 */
export const complete: ProviderComplete = async ({ model, system, prompt, temperature, maxTokens }) => {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env().ANTHROPIC_API_KEY ?? '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      system,
      max_tokens: maxTokens,
      temperature,
      messages: [
        { role: 'user', content: prompt },
        // Prefill forces the reply to open as JSON.
        { role: 'assistant', content: '{' },
      ],
    }),
  })

  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 400)}`)
  }

  const json = (await res.json()) as {
    content: { type: string; text?: string }[]
    usage?: { input_tokens: number; output_tokens: number }
  }
  const text = json.content.map((c) => c.text ?? '').join('')
  return {
    text: text.trimStart().startsWith('{') ? text : `{${text}`,
    promptTokens: json.usage?.input_tokens ?? 0,
    completionTokens: json.usage?.output_tokens ?? 0,
  }
}
