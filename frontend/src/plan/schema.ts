import { z } from 'zod'

export const TRANSITION_KINDS = ['fade', 'slide', 'wipe'] as const

const keepSegment = z.object({
  op: z.literal('keep_segment'),
  start: z.number(),
  end: z.number(),
  reason: z.string().default(''),
})

const addCaption = z.object({
  op: z.literal('add_caption'),
  segment: z.number().int(),
  text: z.string().min(1),
})

const addTitle = z.object({
  op: z.literal('add_title'),
  text: z.string().min(1),
  duration: z.number().default(1.5),
})

const addTransition = z.object({
  op: z.literal('add_transition'),
  after_segment: z.number().int(),
  kind: z.enum(TRANSITION_KINDS),
})

export const operationSchema = z.discriminatedUnion('op', [keepSegment, addCaption, addTitle, addTransition])

export const planSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ok'),
    summary: z.string().default('AI edit'),
    operations: z.array(operationSchema).min(1),
  }),
  z.object({
    status: z.literal('unsupported'),
    reason: z.string().default('This request is not supported.'),
  }),
])

export type Plan = z.infer<typeof planSchema>
export type OkPlan = Extract<Plan, { status: 'ok' }>
export type Operation = z.infer<typeof operationSchema>
export type KeepSegment = z.infer<typeof keepSegment>

/** A plan after validation: segments sorted, snapped, and index-checked. */
export interface ValidPlan {
  summary: string
  segments: { start: number; end: number; reason: string }[]
  captions: { segment: number; text: string }[]
  title?: { text: string; duration: number }
  transitions: { afterSegment: number; kind: (typeof TRANSITION_KINDS)[number] }[]
  warnings: string[]
}
