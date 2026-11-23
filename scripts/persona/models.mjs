import { loadClaudeModelProfiles } from '../../dist/src/model-profiles.mjs'
import { isCodexOpenAiModel } from '../../dist/src/util.mjs'
import { collect } from './owner.mjs'

// The picker uses SDK model names when unambiguous. Only the adapter's own
// profile IDs go back over the socket. A native Codex model can be present in
// the same model/list and must never become this launcher's default.
export async function readModels(client) {
  const rows = await collect(client, 'model/list', {})
  const profiles = new Map(loadClaudeModelProfiles().map((p) => [p.id, p.sdkModel]))
  const visible = rows.filter(
    (m) => !m.hidden && typeof m.id === 'string' && !isCodexOpenAiModel(m.id),
  )
  const aliases = new Map()
  for (const { id } of visible) {
    const name = profiles.get(id) ?? id
    aliases.set(name, (aliases.get(name) ?? 0) + 1)
  }
  const ids = new Set(visible.map((m) => m.id))
  return visible.map((m) => {
    const alias = profiles.get(m.id) ?? m.id
    const unique = aliases.get(alias) === 1 && (!ids.has(alias) || m.id === alias)
    return {
      profile: m.id,
      processProfile: profiles.has(m.id),
      alias,
      id: unique ? alias : m.id,
      name: m.displayName || m.id,
      efforts: (m.supportedReasoningEfforts ?? []).map((e) => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort,
      isDefault: m.isDefault === true,
    }
  })
}

export function selectedModel(models, requested, current) {
  if (!requested && !current) {
    const model = models.find((m) => m.isDefault)
    if (model) return model
    throw new Error('Choose an available model for the new thread')
  }
  const id = requested || current
  const exact = models.find((m) => m.profile === id || m.id === id)
  if (exact) return exact
  const pinned = models.find((m) => m.profile === current && m.alias === id)
  if (pinned) return pinned
  throw new Error(
    'This model is unavailable or ambiguous on this adapter. Choose a listed profile.',
  )
}

export function settings(model, effort) {
  if (!effort) return {}
  const value = effort === 'auto' ? model.defaultEffort : effort
  if (!value || !model.efforts.includes(value))
    throw new Error('This model does not offer the requested reasoning effort')
  return { effort: value }
}
