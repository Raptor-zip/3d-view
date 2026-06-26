<script lang="ts">
  import { fly } from 'svelte/transition';
  import { notifications } from './notifications';

  const label = { info: '情報', warning: '注意', error: 'エラー' } as const;
</script>

<div class="stack" aria-live="polite" aria-label="通知">
  {#each $notifications as item (item.id)}
    <div class:error={item.level === 'error'} class:warning={item.level === 'warning'} class="toast" role={item.level === 'error' ? 'alert' : 'status'} transition:fly={{ x: 18, duration: 150 }}>
      <div class="bar"></div>
      <div class="content">
        <strong>{label[item.level]}</strong>
        <div class="message">{item.message}</div>
      </div>
      <button onclick={() => notifications.dismiss(item.id)} aria-label="通知を閉じる">×</button>
    </div>
  {/each}
</div>

<style>
  .stack {
    position: fixed;
    z-index: 100;
    top: 14px;
    right: 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: min(390px, calc(100vw - 28px));
    pointer-events: none;
  }

  .toast {
    display: grid;
    grid-template-columns: 4px 1fr auto;
    gap: 10px;
    align-items: start;
    padding: 10px 10px 10px 0;
    border: 1px solid #454b57;
    border-radius: 7px;
    background: #292d35;
    box-shadow: 0 8px 24px rgb(0 0 0 / 32%);
    color: #e6e8eb;
    font: 12px/1.45 system-ui, "Hiragino Sans", "Noto Sans JP", sans-serif;
    pointer-events: auto;
  }

  .bar { align-self: stretch; border-radius: 6px; background: #4f9cff; }
  .error .bar { background: #ff5b50; }
  .warning .bar { background: #ffb347; }
  strong { display: block; margin-bottom: 2px; font-size: 10px; color: #bfc4cc; }
  .message { white-space: pre-line; overflow-wrap: anywhere; }

  button {
    appearance: none;
    border: 0;
    padding: 0 2px;
    background: transparent;
    color: #bfc4cc;
    cursor: pointer;
    font-size: 18px;
    line-height: 16px;
  }

  button:hover { color: #fff; }
</style>
