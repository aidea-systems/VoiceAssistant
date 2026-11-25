import { describe, expect, it } from 'vitest'

import { ERROR_LABELS_HR, errorLabel, TOOL_LABELS_HR, toolLabel } from './labels'

describe('labels', () => {
  it('L01: every demo-pack tool has a Croatian chip label; an unknown tool shows its name', () => {
    for (const tool of ['search_items', 'get_item', 'create_note']) {
      expect(TOOL_LABELS_HR[tool]).toBeTruthy()
      expect(toolLabel(tool)).toBe(TOOL_LABELS_HR[tool])
    }
    expect(toolLabel('brand_new_tool')).toBe('brand_new_tool')
  })

  it('L06: every mail-pack tool has a Croatian chip label', () => {
    for (const tool of [
      'list_mail',
      'read_mail',
      'search_mail',
      'list_calendar',
      'reply_mail',
      'flag_mail',
      'send_mail',
    ]) {
      expect(TOOL_LABELS_HR[tool]).toBeTruthy()
      expect(toolLabel(tool)).not.toBe(tool)
    }
  })

  it('L02: a client-side code gets its label; a server code falls through to the message it came with', () => {
    expect(errorLabel('rename_failed', '')).toBe(ERROR_LABELS_HR.rename_failed)
    expect(errorLabel('model_timeout', 'Model nije odgovorio na vrijeme.')).toBe(
      'Model nije odgovorio na vrijeme.',
    )
  })
})
