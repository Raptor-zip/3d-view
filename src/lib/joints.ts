import { writable } from 'svelte/store';

export interface JointCard {
  name: string;
  type: string;
  lower: number;
  upper: number;
  value: number;
  /** 表示用の単位（rad の関節は deg に直して見せる） */
  unit: 'deg' | 'mm' | '';
}

export interface RobotCard {
  id: number;
  name: string;
  joints: JointCard[];
}

export const robotCards = writable<RobotCard[]>([]);

export type JointAction = 'set-value' | 'reset' | 'home';

export function dispatchJointAction(id: number, action: JointAction, name?: string, value?: number): void {
  window.dispatchEvent(new CustomEvent('viewer:joint-action', { detail: { id, action, name, value } }));
}
