import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button";
import { GuideTargetRegistry, useGuideTargetRevision } from "./targets";

interface NotePosition { readonly top: number; readonly left: number; readonly width: number; readonly target: DOMRect }

export interface GuideDisplayProps {
  readonly registry: GuideTargetRegistry;
  readonly targetId: string | null;
  readonly entityId: string | null;
  readonly title: string;
  readonly note: string;
  readonly progress: string;
  readonly step: number;
  readonly phase: "offered" | "active" | "paused" | "complete";
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly onShow?: () => void;
  readonly onPause: () => void;
  readonly onResume: () => void;
  readonly onDismiss: () => void;
  readonly onReturn?: () => void;
  readonly returnLabel?: string;
  readonly showPause?: boolean;
}

const placeNote = (target: HTMLElement): NotePosition => {
  const rect = target.getBoundingClientRect();
  const width = Math.min(340, window.innerWidth - 24);
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
  const above = rect.bottom + 264 > window.innerHeight && rect.top > 206;
  const top = above ? Math.max(12, rect.top - 202) : Math.min(window.innerHeight - 260, rect.bottom + 12);
  return { top: Math.max(12, top), left, width, target: rect };
};

export function GuideDisplay({ registry, targetId, entityId, title, note, progress, step, phase, actionLabel, onAction, onShow, onPause, onResume, onDismiss, onReturn, returnLabel = "Return to work", showPause = true }: GuideDisplayProps) {
  const revision = useGuideTargetRevision(registry);
  const [position, setPosition] = useState<NotePosition | null>(null);
  const focusedTarget = useRef<string | null>(null);
  const noteElement = useRef<HTMLElement | null>(null);
  const target = targetId === null ? null : registry.find(targetId, entityId);
  useLayoutEffect(() => {
    if (phase !== "active" || target === null) { setPosition(null); return; }
    const update = () => setPosition(placeNote(target.element));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(target.element);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { observer.disconnect(); window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [phase, target?.element, revision]);
  useEffect(() => {
    if (phase !== "active" || target === null) return;
    const rect = target.element.getBoundingClientRect();
    const frame = requestAnimationFrame(() => {
      if (window.matchMedia("(max-width: 760px)").matches) noteElement.current?.scrollIntoView({ block: "start", behavior: "instant" });
      else if (rect.top < 0 || rect.bottom > window.innerHeight) target.element.scrollIntoView({ block: "center", behavior: "instant" });
    });
    if (focusedTarget.current !== target.id && (target.element.hasAttribute("tabindex") || target.element.tabIndex >= 0)) {
      focusedTarget.current = target.id;
      target.element.focus({ preventScroll: true });
    }
    return () => cancelAnimationFrame(frame);
  }, [phase, target?.element]);
  useEffect(() => {
    if (phase !== "active") return;
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") onPause(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [phase, onPause]);

  return <>
    <aside className="task-trail" aria-label="Task trail" data-guidance-status={phase} data-guidance-step={step}>
      <div><strong>{title}</strong><span>{progress}</span></div>
      <div className="task-trail-actions">
        {phase === "paused" ? <Button variant="link" onClick={onResume}>Resume</Button> : phase === "active" && showPause ? <Button variant="link" onClick={onPause}>Pause</Button> : null}
        {onReturn !== undefined && <Button variant="link" onClick={onReturn}>{returnLabel}</Button>}
        <Button variant="icon" aria-label="Dismiss guide" onClick={onDismiss}>×</Button>
      </div>
    </aside>
    {phase === "offered" && <div className="guide-offer" aria-live="polite"><p>{note}</p>{onShow !== undefined && <Button onClick={onShow}>Show me</Button>}</div>}
    {phase === "active" && position !== null && target !== null && <>
      <div className="guide-outline" aria-hidden="true" style={{ top: position.target.top - 4, left: position.target.left - 4, width: position.target.width + 8, height: position.target.height + 8 }} />
      <aside ref={noteElement} className="work-note" aria-label="Notes on work" style={{ top: position.top, left: position.left, width: position.width }}>
        <span className="work-note-label">Notes on work</span>
        <p>{note}</p>
        {actionLabel !== undefined && onAction !== undefined && <Button onClick={onAction}>{actionLabel}</Button>}
      </aside>
    </>}
    {phase === "active" && targetId !== null && target === null && <div className="guide-missing" aria-live="polite"><p>{note}</p><p>The marked area is not on screen yet. Open it with the controls in this view, or return to your task.</p>{onShow !== undefined && <Button variant="link" onClick={onShow}>Show me</Button>}</div>}
  </>;
}
