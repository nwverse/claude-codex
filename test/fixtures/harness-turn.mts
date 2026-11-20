// An adapter-* suite in miniature: one mock turn on a mock adapter that the
// shared harness starts. hermetic-env.test runs it with node --test, without
// the preload npm test adds, as a developer runs a single suite.
import test from 'node:test'
import { mockTurnMessages } from '../support/adapter-harness.mjs'

test('one mock turn through the adapter harness', async () => {
  await mockTurnMessages('hello')
})
