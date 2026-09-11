// The welcome panel at the top of the student's setup screen. The instructor
// writes it in the dashboard (Settings, "Welcome panel for students"; stored
// as the `student_panel` settings row), and it reaches the student with
// GET /api/me. The dashboard's live preview uses this same renderer, so what
// the instructor sees is what students see.
//
// The format is deliberately small, so it is quick to learn and cannot break
// the page:
//   # Heading        a large heading
//   ## Heading       a smaller heading
//   (empty line)     starts a new paragraph
//   - item           a bullet; consecutive "- " lines form one list
//   **text**         bold
// Everything renders as React text, never as HTML, so nothing an instructor
// types can inject markup or script into a student's page.

import { Fragment, type ReactNode } from "react";

/** What students see while no instructor has saved a panel. */
export const DEFAULT_PANEL_TEXT = `# Research Interview Trainer

Practice qualitative research interviewing by speaking with a simulated interviewee. Each interviewee gives a rehearsed account of their reasons at first and will only disclose what actually happened to an interviewer who earns it by following up, noticing what is left unsaid, and not judging. When you end the interview you receive a report: speaking metrics, and a rubric assessment that includes how far beneath the surface account you managed to get.

The interview is voice-only: your browser will ask for microphone access. Speak your questions out loud; the interviewee answers with voice. Interviews are time-limited, and the remaining time appears as you approach the end.`;

/** The longest panel the server stores. Keep in step with STUDENT_PANEL_MAX in worker/admin.ts. */
export const PANEL_MAX_LENGTH = 4000;

type Block = { kind: "h1" | "h2" | "p" | "ul"; lines: string[] };

function parse(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      open = null;
      continue;
    }
    if (line.startsWith("## ") || line.startsWith("# ")) {
      const h2 = line.startsWith("## ");
      blocks.push({ kind: h2 ? "h2" : "h1", lines: [line.slice(h2 ? 3 : 2)] });
      open = null;
      continue;
    }
    const kind = line.startsWith("- ") ? "ul" : "p";
    const content = kind === "ul" ? line.slice(2) : line;
    if (open && open.kind === kind) {
      open.lines.push(content);
    } else {
      open = { kind, lines: [content] };
      blocks.push(open);
    }
  }
  return blocks;
}

/** `**bold**` inside one line. An unclosed pair simply runs to the line's end. */
function inline(text: string): ReactNode[] {
  return text
    .split("**")
    .map((part, i) => (i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>));
}

/** Renders panel text as headings, paragraphs and lists. */
export function PanelText({ text }: { text: string }) {
  return (
    <>
      {parse(text).map((block, i) => {
        if (block.kind === "h1") return <h1 key={i}>{inline(block.lines[0])}</h1>;
        if (block.kind === "h2") return <h2 key={i}>{inline(block.lines[0])}</h2>;
        if (block.kind === "ul") {
          return (
            <ul key={i}>
              {block.lines.map((line, j) => (
                <li key={j}>{inline(line)}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {block.lines.map((line, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(line)}
              </Fragment>
            ))}
          </p>
        );
      })}
    </>
  );
}
