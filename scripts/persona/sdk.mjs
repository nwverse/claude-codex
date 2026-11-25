// Persona distributes the runtime SDK with its source and node. Use the SDK
// installed by the operator, without requiring Persona in the adapter process.
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'

const entry = process.env.CLAUDE_CODEX_PERSONA_SDK
if (!entry || !isAbsolute(entry))
  throw new Error(
    'Set CLAUDE_CODEX_PERSONA_SDK to the absolute path of the Persona runtime SDK index.js',
  )

export const { createRuntime, RpcError, page, clipInput, light } = await import(
  pathToFileURL(entry).href
)
