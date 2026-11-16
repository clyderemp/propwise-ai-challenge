import { z } from 'zod';
import { ASSISTANT_PROPERTY_TYPES, Extraction, FOLLOW_UP_KINDS, LEAD_INTENTS, TIMELINE_KINDS, WEEKDAYS } from '../assistant.types';

/**
 * Structured-output schemas (plan 2.4 and 2.6). Every field is required and nullable where it can
 * be empty, so the provider's structured output can enforce the shape. Numeric bounds are not put in
 * the schema (structured outputs do not support them); code sanitises values after parsing.
 */

export const extractionSchema = z.object({
  requirements: z.object({
    locations: z.array(z.string()).describe('Area names. Use the exact spelling from the agency area list when one matches.'),
    bedroomsMin: z.number().int().nullable().describe('0 = studio. null when not stated.'),
    bedroomsMax: z.number().int().nullable().describe('Equal to bedroomsMin for a single value.'),
    budgetMinAed: z.number().int().nullable().describe('In AED. null when not stated.'),
    budgetMaxAed: z.number().int().nullable().describe('The stated figure in AED, not padded.'),
    budgetIsApproximate: z.boolean().describe('True for "around", "about", "~", "roughly", "حوالي".'),
    propertyType: z.enum(ASSISTANT_PROPERTY_TYPES).nullable(),
    intent: z.enum(LEAD_INTENTS),
    preferences: z.array(z.string()).describe('Other wishes, short, e.g. "good rental yield", "sea view".'),
    prioritiseYield: z.boolean().describe('True when the lead cares about rental yield / return / investment income.'),
    listingReferences: z.array(z.string()).describe('Listing codes the lead names, e.g. "MBR-1009". [] when none.'),
  }),
  followUp: z.object({
    kind: z.enum(FOLLOW_UP_KINDS),
    days: z.number().int().nullable().describe('relative_days only: 0 today, 1 tomorrow, 2 the day after tomorrow.'),
    weekday: z.enum(WEEKDAYS).nullable().describe('weekday only.'),
    month: z.number().int().nullable().describe('absolute_date only: 1-12.'),
    day: z.number().int().nullable().describe('absolute_date only: 1-31.'),
    year: z.number().int().nullable().describe('absolute_date only, when stated.'),
    time: z.string().nullable().describe('"HH:MM" 24h, only when the lead stated a time.'),
    quote: z.string().nullable().describe('The exact words the timing was read from.'),
    unclearReason: z.string().nullable().describe('unclear only: why the timing cannot be pinned to a date.'),
  }),
  timeline: z
    .object({
      kind: z.enum(TIMELINE_KINDS).describe('How soon the lead means to buy or move. Not when to contact them.'),
      days: z.number().int().nullable().describe('within_days only: "within 2 weeks" = 14.'),
      month: z.number().int().nullable().describe('by_date only: 1-12.'),
      day: z.number().int().nullable().describe('by_date only: 1-31.'),
      year: z.number().int().nullable().describe('by_date only, when stated.'),
      quote: z.string().nullable().describe('The exact words the timeline was read from.'),
    })
    .describe("The lead's purchase or move timeline, separate from followUp."),
  leadAskedForFollowUp: z.boolean().describe('True when the lead asks the agent to contact or follow up with them.'),
});

export type ExtractionOutput = z.infer<typeof extractionSchema>;

// Compile-time check: the schema output is exactly the domain type.
const _extractionMatches: (x: ExtractionOutput) => Extraction = (x) => x;
void _extractionMatches;

export const MAX_TASK_TITLE = 200;
export const MAX_TASK_NOTES = 5000;
export const MAX_REASON = 600;
export const MAX_SUMMARY = 2000;

export const analysisSchema = z.object({
  recommendations: z
    .array(
      z.object({
        propertyId: z.string().describe('The id from a tool result. Never invent one.'),
        reason: z.string().describe('One or two sentences citing price, gross yield and status from the tool results.'),
      }),
    )
    .describe('Best first, at most 5. [] when nothing fits.'),
  summary: z.string().describe('A few sentences for the agent: what the lead wants, what fits, data issues, next step.'),
  followUpTask: z
    .object({
      title: z.string().describe('Short imperative task title, e.g. "Call Karim about Dubai Marina 2BR options".'),
      notes: z.string().nullable().describe('What to cover in the follow-up, with listing codes.'),
    })
    .nullable()
    .describe('null when no follow-up is needed.'),
});

export type AnalysisOutput = z.infer<typeof analysisSchema>;
