export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: string;
  kind: ToastKind;
  title?: string;
  message: string;
}

class ToastStore {
  list = $state<Toast[]>([]);
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  push(input: { kind: ToastKind; title?: string; message: string; ttl?: number }): string {
    const id = `toast-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const toast: Toast = { id, kind: input.kind, title: input.title, message: input.message };
    this.list = [...this.list, toast];
    // ttl=0 → sticky; otherwise auto-dismiss. Default 6s for non-error, 10s for error.
    const ttl = input.ttl ?? (input.kind === 'error' ? 10_000 : 6_000);
    if (ttl > 0) {
      const handle = setTimeout(() => this.dismiss(id), ttl);
      this.timers.set(id, handle);
    }
    return id;
  }

  dismiss(id: string): void {
    const handle = this.timers.get(id);
    if (handle) {
      clearTimeout(handle);
      this.timers.delete(id);
    }
    this.list = this.list.filter((t) => t.id !== id);
  }

  clear(): void {
    for (const handle of this.timers.values()) clearTimeout(handle);
    this.timers.clear();
    this.list = [];
  }
}

export const toasts = new ToastStore();
