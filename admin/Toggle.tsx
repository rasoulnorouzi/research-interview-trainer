// A binary setting as an on/off switch (instructor request, 2026-08-26):
// clearer than a bare checkbox, and the state is written out as On or Off.
// It stays a real <input type="checkbox"> underneath, so keyboard use and
// form semantics do not change. Styles live in src/index.css (.toggle).

import { Help } from "./Help";

interface Props {
  id: string;
  label: string;
  checked: boolean;
  /** Renders the switch inert and dimmed; used when another setting overrides this one. */
  disabled?: boolean;
  /** Optional explanation, shown behind a "?" after the label. */
  help?: React.ReactNode;
  onChange: (checked: boolean) => void;
}

export function Toggle({ id, label, checked, disabled, help, onChange }: Props) {
  return (
    <label className="toggle" htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true"></span>
      <span className="toggle-state">{checked ? "On" : "Off"}</span>
      <span>{label}</span>
      {/* Outside the <span> holding the label text so the "?" is not part of
          the clickable label: clicking it must open the note, not flip the
          switch. */}
      {help ? <Help label={label}>{help}</Help> : null}
    </label>
  );
}
