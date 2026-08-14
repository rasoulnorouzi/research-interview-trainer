// The OpenAI realtime voices a persona may be cast in. Same list as the
// doc comment on Persona.voiceName in ./types.
//
// Unlike the model ids, this list is enforced server-side (worker/admin.ts):
// a voice the API does not know fails at session start, in front of a student,
// which is the worse failure. Keep it in sync if OpenAI adds a voice.
//
// The three built-in personas use marin (Elena), cedar (Tom) and coral
// (Jasmine); marin and cedar are the most natural of these and go to the two
// personas that must not sound performed. See CLAUDE.md, "The persona system".
export const REALTIME_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "sage",
  "shimmer",
  "verse",
  "marin",
  "cedar",
] as const;
