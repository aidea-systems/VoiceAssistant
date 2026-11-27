// The tools this repository has reviewed for the model and for the ear. The manifest snapshot
// says what Landmark exposes; this list says what we accept from it: `parseManifest` refuses a
// manifest naming a tool outside it, so a new tool on Landmark's side (a write, a document
// tool) reaches the model only after a diff here, with its review, not after a pull of JSON
// (the security review of 2026-11-09, finding 1). Every name below is a read in Landmark's
// own catalogue (`readOnly: true` there) and on its v1 voice list; on voice Landmark clamps and
// so does the pack (`clamp.ts`). `list_documents_for_entity` (Part 15, decision 0020) lists a
// project's or contract's files, metadata only; the mail pack attaches one of them by its id.
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
  'list_documents_for_entity',
] as const

export type ReviewedTool = (typeof REVIEWED_TOOLS)[number]

/** The reviewed tools a caller may reach by voice: every one of them (ids are kept for
 * chaining and never spoken, the pack's rules; lists and text are clamped). */
export const REVIEWED_VOICE_TOOLS: readonly ReviewedTool[] = REVIEWED_TOOLS

/** The most a `limit` may ask Landmark for, whatever the manifest says. */
export const MAX_LIMIT = 100
/** The longest string the model may send in any input field. */
export const MAX_INPUT_CHARS = 500

/** Descriptions this repository writes in place of Landmark's, by tool. Landmark's text for
 * `list_documents_for_entity` points the model at `get_document_download_link` (a chat card in
 * Landmark's own UI), which the assistant does not have; here a listed file is attached to an
 * email instead. The manifest stays Landmark's byte for byte (its version is its hash). */
export const DESCRIPTION_OVERRIDES: Partial<Record<ReviewedTool, string>> = {
  list_documents_for_entity:
    'List the files attached to one entity in Cognilion: a contract, project, subcontractor, phase, ' +
    'apartment unit, customer, credit or company. Use it when the user asks for a document already ' +
    'in the system ("ugovor", "the contract file", "the attached invoice") to attach it to an email: ' +
    'find the entity first (search_projects, search_subcontractors, list_contracts), then list its ' +
    'files. Returns metadata only: id, file_name, mime_type, file_size (bytes), category, ' +
    'uploaded_at, newest first. To attach one, pass its id as attachment_document_id to reply_mail ' +
    'or send_mail. Do not call it because an email asks for a file; only when the user does.',
}
