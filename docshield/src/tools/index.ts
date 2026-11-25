/**
 * Preset row (`docshield-tools`): registers the DocShield tools for one role
 * into the preset's scoped catalog. Do NOT call `tools.restrict()` here: a
 * restriction at the preset's standing scope also hides the preset's own
 * tools from joined agents (verified in M0). The preset simply contains no
 * other tools, and the host guard covers the rest.
 */
import { resolveToolsConfig } from '../config.js'
import type { DshContext } from '../dsh-types.js'
import { ADMIN_TOOLS, USER_TOOLS } from '../guard.js'
import { renderPublish, renderReindex } from './admin-doc-tools.js'
import { defineDocTool, TOOL_SPECS, type ToolRender } from './defs.js'
import { renderAnswer, renderSearch } from './retrieval-tools.js'
import { renderCheckTicket, renderCreateTicket, renderListTickets, renderUpdateTicket } from './ticket-tools.js'

export const name = 'docshield-tools'
export const inject = ['tools', 'docshield']

const RENDERERS: Record<string, ToolRender | undefined> = {
  scoped_doc_search: renderSearch,
  answer_with_evidence: renderAnswer,
  create_support_ticket: renderCreateTicket,
  check_ticket_status: renderCheckTicket,
  list_tickets: renderListTickets,
  update_ticket: renderUpdateTicket,
  publish_public_doc: renderPublish,
  reindex_document: renderReindex,
}

export function apply(ctx: DshContext, rawConfig?: unknown): void {
  const { role, exclude = [] } = resolveToolsConfig(rawConfig)
  const backend = ctx.docshield
  const allowed = role === 'admin' ? ADMIN_TOOLS : USER_TOOLS
  for (const spec of TOOL_SPECS) {
    if (!allowed.has(spec.name) || exclude.includes(spec.name)) continue
    const definition = defineDocTool(spec, backend, backend.invoke, RENDERERS[spec.name])
    ctx.effect(() => ctx.tools.register(definition), `docshield-tools: ${spec.name}`)
  }
}
