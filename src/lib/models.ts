import { writable } from 'svelte/store';

export interface ModelCard {
  id: number;
  name: string;
  isGcode: boolean;
  color: string;
  visible: boolean;
  thumb: string | null;
  opacity: number;
  parts?: ModelPartCard[];
  details: Array<{ label: string; value: string; wide?: boolean }>;
}
export interface ModelPartCard {
  index: number;
  name: string;
  visible: boolean;
  tri: number;
}

export const modelCards = writable<ModelCard[]>([]);
export const selectedModelId = writable<number | null>(null);

export type ModelAction = 'activate' | 'cycle-color' | 'set-visible' | 'remove' | 'select' | 'set-opacity' | 'set-part-visible' | 'set-all-parts-visible';
export type ModelActionValue = boolean | number | { partIndex: number; visible: boolean };

export function dispatchModelAction(id: number, action: ModelAction, value?: ModelActionValue): void {
  window.dispatchEvent(new CustomEvent('viewer:model-action', { detail: { id, action, value } }));
}
