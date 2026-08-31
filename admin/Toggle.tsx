// A binary setting as an on/off switch (instructor request, 2026-08-26):
// clearer than a bare checkbox, and the state is written out as On or Off.
// It stays a real <input type="checkbox"> underneath, so keyboard use and
// form semantics do not change. Styles live in src/index.css (.toggle).

interface Props {
  id: string;
  label: string;
  checked: boolean;
  /** Renders the switch inert and dimmed; used when another setting overrides this one. */
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function Toggle({ id, label, checked, disabled, onChange }: Props) {
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
    </label>
  );
}
