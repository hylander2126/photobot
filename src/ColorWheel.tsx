import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

interface HSV {
  h: number; // 0..360
  s: number; // 0..1
  v: number; // 0..1
}

function hsvToHex({ h, s, v }: HSV) {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return '#' + [f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('');
}

function hexToHsv(hex: string): HSV {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Compact HSV colour wheel in a popover: hue by angle, saturation by radius, plus a brightness slider. */
export function ColorWheel({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  const [open, setOpen] = useState(false);
  // Keep HSV locally so hue survives when saturation or brightness hits 0.
  const [hsv, setHsv] = useState(() => hexToHsv(value));
  const [draft, setDraft] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const wheelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (value.toLowerCase() !== hsvToHex(hsv)) setHsv(hexToHsv(value));
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const commit = (next: HSV) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  const pickAt = (e: ReactPointerEvent) => {
    const rect = wheelRef.current!.getBoundingClientRect();
    const radius = rect.width / 2;
    const dx = e.clientX - rect.left - radius;
    const dy = e.clientY - rect.top - radius;
    const h = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360; // clockwise from top, like conic-gradient
    commit({ ...hsv, h, s: Math.min(1, Math.hypot(dx, dy) / radius) });
  };

  const markerAngle = (hsv.h * Math.PI) / 180;
  const marker = {
    left: `${50 + 50 * hsv.s * Math.sin(markerAngle)}%`,
    top: `${50 - 50 * hsv.s * Math.cos(markerAngle)}%`,
  };

  return (
    <div className="wheel-root" ref={rootRef}>
      <button
        className={`swatch wheel-button ${open ? 'active' : ''}`}
        title="Custom colour"
        aria-label="Custom colour"
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="wheel-pop">
          <div
            ref={wheelRef}
            className="wheel"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              pickAt(e);
            }}
            onPointerMove={(e) => e.buttons && pickAt(e)}
          >
            <div className="wheel-dim" style={{ opacity: 1 - hsv.v }} />
            <div className="wheel-marker" style={{ ...marker, background: value }} />
          </div>
          <input
            className="wheel-v"
            type="range"
            min={0}
            max={100}
            value={Math.round(hsv.v * 100)}
            onChange={(e) => commit({ ...hsv, v: Number(e.target.value) / 100 })}
            style={{ background: `linear-gradient(to right, #000, ${hsvToHex({ ...hsv, v: 1 })})` }}
            aria-label="Brightness"
          />
          <div className="wheel-hex">
            <span className="wheel-chip" style={{ background: value }} />
            <input
              value={draft}
              spellCheck={false}
              onChange={(e) => {
                const v = e.target.value.trim();
                setDraft(v);
                const hex = v.startsWith('#') ? v : `#${v}`;
                if (HEX_RE.test(hex)) onChange(hex.toLowerCase());
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
