// Croatian labels for tool chips and for failures the client itself detects. The API's own error
// messages are already Croatian (the catalogue in @va/core), so a server code falls through to the
// message it came with. Croatian-only on purpose, like the model's answers. <!-- needs native review -->

export const TOOL_LABELS_HR: Record<string, string> = {
  search_items: 'Pretraživanje artikala',
  get_item: 'Učitavanje artikla',
  create_note: 'Spremanje bilješke',
  // The mail pack (Part 13b).
  list_mail: 'Provjera pošte',
  read_mail: 'Čitanje poruke',
  search_mail: 'Pretraživanje pošte',
  list_calendar: 'Pregled kalendara',
  reply_mail: 'Slanje odgovora',
  flag_mail: 'Označavanje poruke',
  // New mail from chat (decision 0019).
  send_mail: 'Slanje poruke',
}

export const ERROR_LABELS_HR: Record<string, string> = {
  // Client-side codes: nothing came back from the server, or a read through supabase-js failed.
  load_failed: 'Greška pri učitavanju razgovora.',
  sessions_load_failed: 'Greška pri učitavanju popisa razgovora.',
  rename_failed: 'Preimenovanje razgovora nije uspjelo. Pokušajte ponovno.',
  delete_failed: 'Brisanje razgovora nije uspjelo. Pokušajte ponovno.',
  network_error: 'Nema veze s poslužiteljem. Pokušajte ponovno.',
  stream_stalled: 'Veza s poslužiteljem je prekinuta. Pokušajte ponovno.',
  unknown_error: 'Neočekivana greška. Pokušajte ponovno.',
  http_error: 'Poslužitelj je odgovorio greškom. Pokušajte ponovno.',
  // Server codes the API may answer before the stream opens without a usable message body.
  unauthorized: 'Niste prijavljeni ili je prijava istekla.',
  rate_limited: 'Previše zahtjeva. Pokušajte ponovno za nekoliko minuta.',
  payload_too_large: 'Zahtjev je prevelik.',
}

/** The chip text for a tool; an unknown tool shows its name, so a new pack is never blank. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS_HR[tool] ?? tool
}

/** The inline error text: our label for the code, else the message that came with it. */
export function errorLabel(code: string, fallback: string): string {
  return ERROR_LABELS_HR[code] ?? fallback
}
