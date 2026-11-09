// The tools this repository has reviewed for the model and for the ear. The manifest snapshot
// says what Landmark exposes; this list says what we accept from it: `parseManifest` refuses a
// manifest naming a tool outside it, so a new tool on Landmark's side (a write, a document
// tool) reaches the model only after a diff here, with its review, not after a pull of JSON
// (the security review of 2026-11-09, finding 1). Every name below is a read in Landmark's
// own catalogue (`readOnly: true` there) and on its v1 voice list; on voice Landmark clamps and
// so does the pack (`clamp.ts`).
export const REVIEWED_TOOLS = [
  'search_projects',
  'get_project_details',
  'list_project_phases',
  'search_subcontractors',
  'list_cost_classifications',
  'list_contracts',
  'get_subcontractor_payment_status',
  'list_unpaid_invoices',
  'list_payments_for_subcontractor',
  'get_invoice_summary',
  'get_project_financial_summary',
  'search_help',
] as const

export type ReviewedTool = (typeof REVIEWED_TOOLS)[number]

/** The reviewed tools a caller may reach by voice: every one of the twelve (ids are kept for
 * chaining and never spoken, the pack's rules; lists and text are clamped). */
export const REVIEWED_VOICE_TOOLS: readonly ReviewedTool[] = REVIEWED_TOOLS

/** The most a `limit` may ask Landmark for, whatever the manifest says. */
export const MAX_LIMIT = 100
/** The longest string the model may send in any input field. */
export const MAX_INPUT_CHARS = 500
