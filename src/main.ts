import { mount } from 'svelte';
import ModelList from './lib/ModelList.svelte';
import ToastStack from './lib/ToastStack.svelte';

const target = document.getElementById('toast-root');
if (!target) throw new Error('toast-root が見つかりません');

mount(ToastStack, { target });

const modelListTarget = document.getElementById('model-list-root');
if (!modelListTarget) throw new Error('model-list-root が見つかりません');

mount(ModelList, { target: modelListTarget });
