// JSON Schema for the edit plan, used where a provider can enforce structured output.
// The frontend still validates every plan (timeline rules can't be expressed here).

const keepSegment = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', const: 'keep_segment' },
    start: { type: 'number' },
    end: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['op', 'start', 'end', 'reason'],
}

const addCaption = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', const: 'add_caption' },
    segment: { type: 'integer' },
    text: { type: 'string' },
  },
  required: ['op', 'segment', 'text'],
}

const addTitle = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', const: 'add_title' },
    text: { type: 'string' },
    duration: { type: 'number' },
  },
  required: ['op', 'text', 'duration'],
}

const addTransition = {
  type: 'object',
  additionalProperties: false,
  properties: {
    op: { type: 'string', const: 'add_transition' },
    after_segment: { type: 'integer' },
    kind: { type: 'string', enum: ['fade', 'slide', 'wipe'] },
  },
  required: ['op', 'after_segment', 'kind'],
}

/** status "unsupported" → operations: [] and a reason; status "ok" → reason: "". */
export const PLAN_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: ['ok', 'unsupported'] },
    summary: { type: 'string' },
    reason: { type: 'string' },
    operations: { type: 'array', items: { anyOf: [keepSegment, addCaption, addTitle, addTransition] } },
  },
  required: ['status', 'summary', 'reason', 'operations'],
}
