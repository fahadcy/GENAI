/**
 * Which parameters go to which OpenAI model.
 *
 * This exists because the failure it guards against is silent and expensive:
 * the GPT-5 family rejects `max_tokens` and a non-default `temperature` with a
 * 400, the gateway catches provider failures and answers from the simulator,
 * and the result is someone paying for an API key while quietly receiving
 * simulated output with nothing on screen to say so.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MODERN_FAMILY, droppedParam } from '../src/lib/ai/providers/openai'

test('newer families are recognised, older ones are not', () => {
  for (const m of ['gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-luna', 'o3-mini', 'gpt-6']) {
    assert.equal(MODERN_FAMILY.test(m), true, `${m} should use the newer parameter shape`)
  }
  for (const m of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini']) {
    assert.equal(MODERN_FAMILY.test(m), false, `${m} should keep the older shape`)
  }
})

test('a max_tokens rejection is recognised from the named parameter', () => {
  assert.equal(droppedParam({ status: 400, param: 'max_tokens', message: 'Unsupported parameter' }), 'max_tokens')
})

test('a max_tokens rejection is recognised from the message alone', () => {
  assert.equal(
    droppedParam({
      status: 400,
      message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    }),
    'max_tokens',
  )
})

test('a temperature rejection is recognised', () => {
  assert.equal(
    droppedParam({ status: 400, message: "Unsupported value: 'temperature' does not support 0.7 with this model." }),
    'temperature',
  )
  assert.equal(droppedParam({ status: 400, error: { param: 'temperature', message: 'nope' } }), 'temperature')
})

test('unrelated failures are left alone rather than retried blindly', () => {
  assert.equal(droppedParam({ status: 401, message: 'Incorrect API key provided' }), null)
  assert.equal(droppedParam({ status: 429, message: 'Rate limit reached' }), null)
  assert.equal(droppedParam({ status: 400, message: 'Invalid schema for response_format' }), null)
  assert.equal(droppedParam(new Error('socket hang up')), null)
})
