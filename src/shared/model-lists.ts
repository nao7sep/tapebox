import { z } from 'zod'
export const ModelListsSchema = z.object({
  openai: z.object({ fetchedAtUtc: z.iso.datetime({ offset: true }).refine((value) => /(?:Z|\+00:00)$/.test(value)), ids: z.array(z.string().min(1)) }).optional(),
})
export type ModelLists = z.infer<typeof ModelListsSchema>
