/**
 * The shape of the upstream export, shared by the sync (which loads it) and the checks (which compare it
 * with what the MCP server serves). One definition, so the two can never disagree about what "valid" means.
 */
import fs from "node:fs";
import * as z from "zod/v4";

/** True only for dates that exist: '2026-11-30' yes, '2026-11-31' no. */
export function isRealDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  // JavaScript rolls '2026-11-31' over to 1 December instead of rejecting it, so compare the round trip.
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must look like YYYY-MM-DD")
  .refine(isRealDate, "is not a real calendar date");

export const StaffRecord = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  team: z.string().min(1),
  email: z.string().min(3)
});

export const PublicationRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  summary: z.string().min(1),
  topic: z.string().min(1),
  published_on: IsoDate,
  author_id: z.string().min(1),
  url: z.string().min(1)
});

export const EventRecord = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  starts_on: IsoDate,
  location: z.string().min(1),
  owner_id: z.string().min(1)
});

/** The file as a whole. Records stay `unknown` here so that one bad record can be reported by name. */
export const ExportFile = z.object({
  exported_at: z.string(),
  staff: z.array(z.unknown()),
  publications: z.array(z.unknown()),
  events: z.array(z.unknown())
});

export type Staff = z.infer<typeof StaffRecord>;
export type Publication = z.infer<typeof PublicationRecord>;
export type Event = z.infer<typeof EventRecord>;
export type Export = z.infer<typeof ExportFile>;

/** Reads and parses the export file. Throws with a readable message if the file is missing or not JSON. */
export function readExport(file: string): Export {
  return ExportFile.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}
