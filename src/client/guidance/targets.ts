import { useCallback, useSyncExternalStore, type RefCallback } from "react";

export interface RegisteredGuideTarget {
  readonly id: string;
  readonly entityId: string | null;
  readonly element: HTMLElement;
  readonly available: boolean;
}

export class GuideTargetRegistry {
  private readonly targets = new Map<string, RegisteredGuideTarget>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  snapshot = (): number => this.revision;

  register(id: string, entityId: string | null, element: HTMLElement | null, available: boolean): void {
    const current = this.targets.get(id);
    if (element === null) {
      if (current === undefined) return;
      this.targets.delete(id);
    } else {
      if (current?.element === element && current.entityId === entityId && current.available === available) return;
      this.targets.set(id, { id, entityId, element, available });
    }
    this.revision++;
    for (const listener of this.listeners) listener();
  }

  find(id: string, entityId: string | null): RegisteredGuideTarget | null {
    const target = this.targets.get(id);
    if (target === undefined || target.entityId !== entityId || !target.element.isConnected) return null;
    if (target.element.hidden || target.element.getClientRects().length === 0) return null;
    return target;
  }

  visibleTargetIds(): ReadonlyArray<string> {
    return [...this.targets.values()].filter(({ element }) => {
      if (!element.isConnected || element.hidden || element.getClientRects().length === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
    }).slice(0, 24).map(({ id }) => id);
  }

  disabledTargetIds(): ReadonlyArray<string> {
    return [...this.targets.values()].filter(({ element, available }) => !available && element.isConnected).slice(0, 24).map(({ id }) => id);
  }
}

export const useGuideTarget = (
  registry: GuideTargetRegistry,
  id: string,
  entityId: string | null,
  available = true,
): RefCallback<HTMLElement> => useCallback((element) => {
  registry.register(id, entityId, element, available);
}, [registry, id, entityId, available]);

export const useGuideTargetRevision = (registry: GuideTargetRegistry): number =>
  useSyncExternalStore(registry.subscribe, registry.snapshot, registry.snapshot);
