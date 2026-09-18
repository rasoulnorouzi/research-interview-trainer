import { useEffect, useId, useRef, useState } from "react";

// The "?" next to a field (instructor request, 2026-09-18). It opens on hover
// and on click, so a mouse user gets it by passing over and a touch or
// keyboard user gets it by pressing. Click keeps it open until the next click
// or Escape, because several of these explanations are longer than a glance.
//
// The button is a real <button> with aria-expanded, and the panel is described
// by it, so a screen reader announces "more information" rather than a stray
// question mark. Hover alone would strand both touch and keyboard.

interface Props {
  /** A short label naming what is explained, for screen readers. */
  label: string;
  /** The explanation. Paragraphs, kept short. */
  children: React.ReactNode;
}

export function Help({ label, children }: Props) {
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  // How far the panel is nudged sideways to stay on screen. A "?" near either
  // edge of a phone would otherwise hang its panel off the viewport. Flipping
  // the anchor swaps one overflow for the other, so the panel is measured once
  // it opens and shifted by exactly the overflow.
  const [shift, setShift] = useState(0);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLSpanElement>(null);
  const panelId = useId();

  const open = pinned || hovered;

  // A pinned panel closes on Escape or on a click anywhere else, the way a
  // popover is expected to behave. Hover-only panels need neither.
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPinned(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [pinned]);

  useEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const margin = 8;
    let next = shift;
    if (rect.right > window.innerWidth - margin) {
      next = shift - (rect.right - (window.innerWidth - margin));
    } else if (rect.left < margin) {
      next = shift + (margin - rect.left);
    }
    // A pixel of slack, so a rounding difference cannot start a loop.
    if (Math.abs(next - shift) > 1) setShift(next);
  }, [open, shift]);

  return (
    <span
      className="help-wrap"
      ref={wrapRef}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`help-btn${open ? " is-open" : ""}`}
        aria-label={`What is ${label}?`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={(e) => {
          // Inside a <label> a click would otherwise reach the labelled control.
          e.preventDefault();
          e.stopPropagation();
          setPinned((p) => !p);
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        ?
      </button>
      <span
        className="help-panel"
        id={panelId}
        ref={panelRef}
        role="note"
        hidden={!open}
        style={shift !== 0 ? { transform: `translateX(${Math.round(shift)}px)` } : undefined}
      >
        <strong className="help-title">{label}</strong>
        {children}
      </span>
    </span>
  );
}
