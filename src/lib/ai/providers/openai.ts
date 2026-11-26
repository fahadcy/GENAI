import 'server-only'
import OpenAI from 'openai'
import { env } from '@/lib/env'
import type { ProviderComplete } from '../gateway'

let client: OpenAI | null = null

function get(): OpenAI {
  if (!client) {
    const e = env()
    client = new OpenAI({
      apiKey: e.OPENAI_API_KEY,
      baseURL: e.OPENAI_BASE_URL || undefined,
      maxRetries: 2,
      timeout: 60_000,
    })
  }
  return client
}

/**
 * Newer OpenAI families changed two parameters, and both are hard errors rather
 * than warnings: `max_tokens` became `max_completion_tokens`, and `temperature`
 * only accepts its default. Sending the old shape to a GPT-5 model returns a
 * 400, which the gateway would catch and quietly answer from the simulator —
 * so someone who has paid for an API key would see simulated output and no
 * explanation. Picking the shape from the model name avoids that entirely.
 */
export const MODERN_FAMILY = /^(gpt-5|gpt-6|o[1-9])/i

/**
 * Belt and braces for models we have not seen yet. OpenAI names the offending
 * parameter in the error, so one retry without it is nearly always right, and
 * is far better than degrading to the simulator on a paid key.
 */
export function droppedParam(error: unknown): string | null {
  const e = error as { status?: number; param?: string; message?: string; error?: { param?: string; message?: string } }
  if (e?.status !== 400) return null
  const param = e.param ?? e.error?.param
  const message = e.message ?? e.error?.message ?? ''
  if (param === 'max_tokens' || /max_tokens.*not supported|use .?max_completion_tokens/i.test(message)) {
    return 'max_tokens'
  }
  if (param === 'temperature' || /temperature.*(not supported|does not support|unsupported)/i.test(message)) {
    return 'temperature'
  }
  return null
}

export const complete: ProviderComplete = async ({ model, system, prompt, temperature, maxTokens }) => {
  const modern = MODERN_FAMILY.test(model)

  const base = {
    model,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: prompt },
    ],
  }

  let params: Record<string, unknown> = modern
    ? { ...base, max_completion_tokens: maxTokens }
    : { ...base, temperature, max_tokens: maxTokens }

  let res
  for (let attempt = 0; ; attempt++) {
    try {
      res = await get().chat.completions.create(params as never)
      break
    } catch (error) {
      const drop = attempt < 2 ? droppedParam(error) : null
      if (!drop) throw error
      if (drop === 'max_tokens') {
        const { max_tokens, ...rest } = params
        params = { ...rest, max_completion_tokens: max_tokens ?? maxTokens }
      } else {
        const { temperature: _t, ...rest } = params
        params = rest
      }
    }
  }

  return {
    text: res.choices[0]?.message?.content ?? '',
    promptTokens: res.usage?.prompt_tokens ?? 0,
    completionTokens: res.usage?.completion_tokens ?? 0,
  }
}

/** Image generation for CS-4. Returns a data URL so nothing needs object storage. */
export async function generateImage(prompt: string, size: '1024x1024' | '1536x1024' = '1536x1024') {
  const res = await get().images.generate({
    model: env().AI_MODEL_IMAGE,
    prompt,
    size,
    n: 1,
  })
  const b64 = res.data?.[0]?.b64_json
  if (b64) return `data:image/png;base64,${b64}`
  return res.data?.[0]?.url ?? null
}
