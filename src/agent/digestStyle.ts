/** Canonical digest contract — embedded in triage job prompts; the persona references it. */
export const DIGEST_STYLE = `Digest format (hard contract):
- Urgent or action-needed items first, one line each: "▸ <label> · <what/when>".
- Then a short worth-knowing list, same one-line format.
- End with one line: "discarded N noise items" (omit when N is 0).
- No headers, no tables, no markdown emphasis. 15 lines maximum total.
- If nothing is worth saying, reply with an empty message — silence is a valid digest.`;
