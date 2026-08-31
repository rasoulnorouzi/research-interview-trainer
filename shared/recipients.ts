// The assessment-recipients setting (`instructor_recipients`), shared by the
// dashboard form, the settings validation and the report email dispatch so all
// three read and write one format.
//
// The stored value is one comma-separated string, human-readable on purpose so
// a hand edit in the database stays possible. An address prefixed with "!" is
// switched OFF: it stays on the list but receives no report emails until it is
// switched on again (instructor request, 2026-08-31). A value stored before
// the switch existed has no "!" anywhere and parses as all-on, so nothing
// changes for it.

export interface Recipient {
  email: string;
  /** False when the address is switched off and gets no report emails. */
  active: boolean;
}

export function parseRecipients(value: string): Recipient[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) =>
      part.startsWith("!")
        ? { email: part.slice(1).trim(), active: false }
        : { email: part, active: true },
    )
    .filter((recipient) => recipient.email.length > 0);
}

export function serializeRecipients(list: Recipient[]): string {
  return list.map((r) => (r.active ? r.email : `!${r.email}`)).join(", ");
}
