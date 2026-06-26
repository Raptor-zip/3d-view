import { writable } from 'svelte/store';

export interface ModelCard {
  id: number;
  name: string;
  isGcode: boolean;
  color: string;
  visible: boolean;
  thumb: string | null;
  opacity: number;
  details: Array<{ label: string; value: string; wide?: boolean }>;
}

export const modelCards = writable<ModelCard[]>([]);
export const selectedModelId = writable<number | null>(null);

export type ModelAction = 'activate' | 'cycle-color' | 'set-visible' | 'remove' | 'select' | 'set-opacity';

export function dispatchModelAction(id: number, action: ModelAction, value?: boolean | number): void {
  window.dispatchEvent(new CustomEvent('viewer:model-action', { detail: { id, action, value } }));
}
