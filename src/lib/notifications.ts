import { writable } from 'svelte/store';

export type NotificationLevel = 'info' | 'warning' | 'error';

export interface ViewerNotification {
  id: number;
  message: string;
  level: NotificationLevel;
}

export interface NotifyOptions {
  level?: NotificationLevel;
  duration?: number;
}

let nextId = 0;
const { subscribe, update } = writable<ViewerNotification[]>([]);

export const notifications = {
  subscribe,
  dismiss(id: number) {
    update((items) => items.filter((item) => item.id !== id));
  },
};

export function notify(message: string, { level = 'info', duration = 5000 }: NotifyOptions = {}): void {
  const id = ++nextId;
  update((items) => [...items, { id, message, level }]);
  if (duration > 0) window.setTimeout(() => notifications.dismiss(id), duration);
}
