import { useEffect, useRef, useState } from 'react';
import { ColorWheel } from './ColorWheel';
import { RobotScene, type RobotState, type ToolName } from './robotScene';
import { decodeShare, shareUrl, type SharedState } from './share';
import { PRESETS } from './themes';

const DEG = 180 / Math.PI;
const JOINT_NAMES = ['Base', 'Shoulder', 'Elbow', 'Wrist'];
const SCALES = [1, 2, 3, 4];
// Image clipboard support (ClipboardItem) is missing in some browsers; hide the button there.
const CAN_COPY_IMAGE = typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write;

/** Apply the scene-side parts of a share link. The tool goes first: the pose depends on its length. */
function applyShared(scene: RobotScene, s: Partial<SharedState>) {
  if (s.tool) scene.setTool(s.tool);
  if (s.target && s.ns) scene.setPose(s.target, s.ns);
  if (s.camPos && s.camTarget) scene.setView(s.camPos, s.camTarget);
}

export default function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<RobotScene | null>(null);

  // A share link in the URL hash seeds the initial state.
  const [shared] = useState(() => decodeShare(window.location.hash));
  const [theme, setTheme] = useState<string>(shared.theme ?? PRESETS.Blue);
  const [tool, setTool] = useState<ToolName>(shared.tool ?? 'gripper');
  const [checker, setChecker] = useState(true);
  const [shadow, setShadow] = useState(shared.shadow ?? true);
  const [scale, setScale] = useState(2);
  const [trim, setTrim] = useState(true);
  const [robot, setRobot] = useState<RobotState | null>(null);
  const [blocked, setBlocked] = useState(false);
  // Text being typed into the tool-pitch box; null shows the live value.
  const [phiDraft, setPhiDraft] = useState<string | null>(null);
  const [phiDraftBad, setPhiDraftBad] = useState(false);
  const phiAtFocus = useRef(0);
  const [exporting, setExporting] = useState(false);
  const [pngCopy, setPngCopy] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [copied, setCopied] = useState(false);
  // Shown only when the clipboard is unavailable, for copying by hand.
  const [manualLink, setManualLink] = useState<string | null>(null);

  // Reference backdrop: an object URL for a local file, shown behind the
  // transparent canvas. Never uploaded, and never part of the export.
  const [bgUrl, setBgUrl] = useState<string | null>(null);
  const [bgName, setBgName] = useState('');
  const [bgFit, setBgFit] = useState<'cover' | 'contain'>('cover');
  const [bgOpacity, setBgOpacity] = useState(1);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadBackground = (file: File | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    setBgUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return URL.createObjectURL(file);
    });
    setBgName(file.name);
  };

  const clearBackground = () => {
    setBgUrl((old) => {
      if (old) URL.revokeObjectURL(old);
      return null;
    });
    if (fileRef.current) fileRef.current.value = '';
  };

  useEffect(() => {
    const scene = new RobotScene(viewportRef.current!);
    scene.onChange = setRobot;
    scene.onBlocked = flashBlocked;
    sceneRef.current = scene;
    applyShared(scene, shared);
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => sceneRef.current?.setTheme(theme), [theme]);
  useEffect(() => sceneRef.current?.setTool(tool), [tool]);
  useEffect(() => sceneRef.current?.setShadow(shadow), [shadow]);

  // Pasting another share link into the address bar only changes the hash, so no reload.
  useEffect(() => {
    const onHash = () => {
      const s = decodeShare(window.location.hash);
      if (s.theme) setTheme(s.theme);
      if (s.tool) setTool(s.tool);
      if (s.shadow !== undefined) setShadow(s.shadow);
      if (sceneRef.current) applyShared(sceneRef.current, s);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const copyLink = async () => {
    const s = sceneRef.current;
    if (!s) return;
    const url = shareUrl({ ...s.getPose(), ...s.getView(), theme, tool, shadow });
    try {
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard can be unavailable (e.g. plain http); show the link to copy by hand.
      setManualLink(url);
    }
  };

  // Brief visual cue when a nullspace move would have to move the tip.
  const flashBlocked = () => {
    setBlocked(true);
    window.setTimeout(() => setBlocked(false), 350);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = sceneRef.current;
      const tag = (e.target as HTMLElement).tagName;
      if (!s || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const step = (e.shiftKey ? 10 : 2) / DEG;
      switch (e.key) {
        case 'ArrowLeft':
          if (!s.nudgePhi(step)) flashBlocked();
          break;
        case 'ArrowRight':
          if (!s.nudgePhi(-step)) flashBlocked();
          break;
        case 'ArrowUp':
          s.setElbowUp(true);
          break;
        case 'ArrowDown':
          s.setElbowUp(false);
          break;
        case ' ':
          s.setElbowUp(!robot?.elbowUp);
          break;
        case 'r':
        case 'R':
          s.reset();
          break;
        default:
          return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [robot?.elbowUp]);

  const exportPng = async () => {
    const s = sceneRef.current;
    if (!s) return;
    setExporting(true);
    try {
      const blob = await s.exportPNG(scale, trim);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const preset = Object.entries(PRESETS).find(([, hex]) => hex === theme)?.[0];
      a.download = `photobot-${(preset ?? theme.slice(1)).toLowerCase()}-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      setExporting(false);
    }
  };

  const copyPng = async () => {
    const s = sceneRef.current;
    if (!s) return;
    setExporting(true);
    setPngCopy('copying');
    try {
      // Hand the clipboard a pending blob rather than awaiting it first: Safari only
      // allows the write while it is still tied to the click.
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': s.exportPNG(scale, trim) })]);
      setPngCopy('copied');
    } catch {
      setPngCopy('failed');
    } finally {
      setExporting(false);
      window.setTimeout(() => setPngCopy('idle'), 1800);
    }
  };

  const size = sceneRef.current?.exportSize(scale);
  const phiDeg = robot ? Math.round(robot.phi * DEG * 10) / 10 : 0;
  const trySetPhiDeg = (deg: number) => {
    const ok = !!sceneRef.current?.setPhi(deg / DEG);
    if (!ok) flashBlocked();
    return ok;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>PhotoBot</h1>
          <p className="sub">Pose · theme · export</p>
        </header>

        <section>
          <div className="label-row">
            <span className="label">Theme</span>
            <span className="hint mono">{theme}</span>
          </div>
          <div className="swatches">
            {Object.entries(PRESETS).map(([name, hex]) => (
              <button
                key={name}
                className={`swatch ${hex === theme ? 'active' : ''}`}
                style={{ background: hex }}
                title={name}
                aria-label={name}
                onClick={() => setTheme(hex)}
              />
            ))}
            <span className="swatch-sep" />
            <ColorWheel value={theme} onChange={setTheme} />
          </div>
        </section>

        <section>
          <span className="label">Tool</span>
          <div className="seg">
            <button className={tool === 'gripper' ? 'on' : ''} onClick={() => setTool('gripper')}>Gripper</button>
            <button className={tool === 'finger' ? 'on' : ''} onClick={() => setTool('finger')}>Finger</button>
          </div>
        </section>

        <section>
          <div className="label-row">
            <span className="label">Nullspace</span>
            <span className="hint">tip stays fixed</span>
          </div>
          <div className={`slider-row ${blocked ? 'blocked' : ''}`}>
            <span>Tool pitch</span>
            <input
              type="range"
              min={-180}
              max={180}
              step={0.1}
              value={phiDeg}
              onChange={(e) => trySetPhiDeg(Number(e.target.value))}
            />
            <label className={`num-box ${phiDraftBad ? 'bad' : ''}`}>
              <input
                type="number"
                step="any"
                min={-180}
                max={180}
                aria-label="Tool pitch in degrees"
                value={phiDraft ?? phiDeg.toFixed(1)}
                onChange={(e) => {
                  setPhiDraft(e.target.value);
                  const n = parseFloat(e.target.value);
                  setPhiDraftBad(Number.isFinite(n) ? !trySetPhiDeg(n) : e.target.value.trim() !== '' && e.target.value !== '-');
                }}
                onFocus={() => (phiAtFocus.current = phiDeg)}
                onBlur={() => {
                  // Typing applies live, so partial entries (e.g. "-17" on the way to "-170")
                  // may have moved the arm. If the final entry is invalid, undo all of it.
                  if (phiDraftBad) sceneRef.current?.setPhi(phiAtFocus.current / DEG);
                  setPhiDraft(null);
                  setPhiDraftBad(false);
                }}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
              />
              <span>°</span>
            </label>
          </div>
          <div className="seg">
            <button className={robot?.elbowUp ? 'on' : ''} onClick={() => sceneRef.current?.setElbowUp(true)}>
              Elbow up
            </button>
            <button className={robot && !robot.elbowUp ? 'on' : ''} onClick={() => sceneRef.current?.setElbowUp(false)}>
              Elbow down
            </button>
          </div>
          <div className="joints">
            {robot?.joints.map((q, i) => (
              <div key={i}>
                <span>{JOINT_NAMES[i]}</span>
                <span className="mono">{(q * DEG).toFixed(1)}°</span>
              </div>
            ))}
          </div>
          <button className="ghost" onClick={() => sceneRef.current?.reset()}>Reset pose</button>
        </section>

        <section>
          <span className="label">View</span>
          <label className="check">
            <input type="checkbox" checked={checker} onChange={(e) => setChecker(e.target.checked)} />
            Checkerboard background
          </label>
          <label className="check">
            <input type="checkbox" checked={shadow} onChange={(e) => setShadow(e.target.checked)} />
            Ground shadow <span className="hint">(included in PNG)</span>
          </label>
        </section>

        <section>
          <div className="label-row">
            <span className="label">Reference image</span>
            <span className="hint">not exported</span>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(e) => loadBackground(e.target.files?.[0])}
          />
          {bgUrl ? (
            <>
              <div className="bg-file">
                <span className="bg-thumb" style={{ backgroundImage: `url(${bgUrl})` }} />
                <span className="bg-name" title={bgName}>{bgName}</span>
                <button className="link" onClick={() => fileRef.current?.click()}>Replace</button>
                <button className="link" onClick={clearBackground}>Remove</button>
              </div>
              <div className="seg">
                <button className={bgFit === 'cover' ? 'on' : ''} onClick={() => setBgFit('cover')}>Fill</button>
                <button className={bgFit === 'contain' ? 'on' : ''} onClick={() => setBgFit('contain')}>Fit</button>
              </div>
              <div className="slider-row">
                <span>Opacity</span>
                <input
                  type="range"
                  min={10}
                  max={100}
                  value={Math.round(bgOpacity * 100)}
                  onChange={(e) => setBgOpacity(Number(e.target.value) / 100)}
                />
                <span className="mono">{Math.round(bgOpacity * 100)}%</span>
              </div>
            </>
          ) : (
            <button className="ghost" onClick={() => fileRef.current?.click()}>
              Choose image… <span className="hint">or drop onto the view</span>
            </button>
          )}
        </section>

        <section>
          <span className="label">Export</span>
          <div className="seg">
            {SCALES.map((s) => (
              <button key={s} className={s === scale ? 'on' : ''} onClick={() => setScale(s)}>{s}×</button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={trim} onChange={(e) => setTrim(e.target.checked)} />
            Trim to robot
          </label>
          <button className="primary" onClick={exportPng} disabled={exporting}>
            {exporting && pngCopy === 'idle' ? 'Exporting…' : 'Export Transparent PNG'}
          </button>
          {CAN_COPY_IMAGE && (
            <button className="ghost" onClick={copyPng} disabled={exporting}>
              {{ idle: 'Copy to clipboard', copying: 'Copying…', copied: 'Copied ✓ Paste anywhere', failed: 'Copy failed. Use Export' }[pngCopy]}
            </button>
          )}
          {size && (
            <p className="hint center">
              {trim
                ? `Robot at up to ${size.w} × ${size.h}px, independent of zoom`
                : `Full view, ${size.w} × ${size.h}px`}
            </p>
          )}
        </section>

        <section>
          <div className="label-row">
            <span className="label">Share</span>
            <span className="hint">pose · camera · colour · tool</span>
          </div>
          <button className="ghost" onClick={copyLink}>
            {copied ? 'Link copied ✓' : 'Copy link to this pose'}
          </button>
          {manualLink && (
            <input
              className="share-url mono"
              readOnly
              value={manualLink}
              aria-label="Share link"
              onFocus={(e) => e.currentTarget.select()}
            />
          )}
          <p className="hint">The reference image is never included.</p>
        </section>

        <section className="help">
          <span className="label">Controls</span>
          <ul>
            <li><b>Drag inside the ring</b> (or the tool) to move the tip</li>
            <li><b>Drag the ring's edge</b> to turn the tool in 15° steps</li>
            <li><b>Drag empty space</b> to orbit · right-drag to pan · scroll to zoom</li>
            <li><kbd>←</kbd><kbd>→</kbd> sweep tool pitch (<kbd>Shift</kbd> for big steps)</li>
            <li><kbd>↑</kbd><kbd>↓</kbd> elbow up / down</li>
            <li><kbd>Space</kbd> toggle elbow branch</li>
            <li><kbd>R</kbd> reset pose</li>
          </ul>
        </section>
      </aside>

      <main
        ref={viewportRef}
        className={`viewport ${checker ? 'checker' : ''} ${dragOver ? 'drop' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          loadBackground(e.dataTransfer.files[0]);
        }}
      >
        {/* Always rendered so it stays before the canvas the scene appends. */}
        <div
          className="bg-ref"
          hidden={!bgUrl}
          style={{
            backgroundImage: bgUrl ? `url(${bgUrl})` : undefined,
            backgroundSize: bgFit,
            opacity: bgOpacity,
          }}
        />
      </main>
    </div>
  );
}
