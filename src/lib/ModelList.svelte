<script lang="ts">
  import { dispatchModelAction, modelCards, selectedModelId, type ModelCard } from './models';

  function setVisible(model: ModelCard, event: Event) {
    dispatchModelAction(model.id, 'set-visible', (event.currentTarget as HTMLInputElement).checked);
  }
</script>

{#if $modelCards.length === 0}
  <div id="empty">まだ読み込まれていません。</div>
{:else}
  <div id="modelList">
    {#each $modelCards as model (model.id)}
      <div class:selected={$selectedModelId === model.id} class="mcard">
        <div class="top">
          {#if model.isGcode}
            <button class="chip" style="background:linear-gradient(90deg,#ff6b3d,#b888ff)" title="G-codeツールパス" aria-label="G-codeツールパス"></button>
            <button class="nm model-name" onclick={() => dispatchModelAction(model.id, 'activate')}>{model.name} <span>G-code</span></button>
          {:else}
            <button class="chip" style={`background:${model.color}`} title="クリックで色変更" aria-label={`${model.name} の色を変更`} onclick={() => dispatchModelAction(model.id, 'cycle-color')}></button>
            <button class="nm model-name" title="モデルを選択" onclick={() => dispatchModelAction(model.id, 'select')}>{model.name}</button>
          {/if}
          <input class="vis" type="checkbox" checked={model.visible} title="表示/非表示" aria-label={`${model.name} を表示`} onchange={(event) => setVisible(model, event)} />
          <button class="del" title="削除" aria-label={`${model.name} を削除`} onclick={() => dispatchModelAction(model.id, 'remove')}>×</button>
        </div>
        <div class="body">
          {#if model.thumb}
            <button
              class="thumb"
              title="クリックでこのモデルを選択"
              aria-label={`${model.name} を選択`}
              onclick={() => dispatchModelAction(model.id, model.isGcode ? 'activate' : 'select')}
            >
              <img src={model.thumb} alt={`${model.name} のプレビュー`} />
            </button>
          {/if}
          <div class="meta">
            {#each model.details as detail}
              <span>{detail.label} <b>{detail.value}</b></span>
            {/each}
          </div>
        </div>
      </div>
    {/each}
  </div>
{/if}

<style>
  .model-name {
    min-width: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    cursor: pointer;
    text-align: left;
  }

  .model-name span { color: var(--muted); font-size: 10px; }

  .body { display: flex; gap: 9px; align-items: flex-start; margin-top: 6px; }
  .body :global(.meta) { flex: 1; min-width: 0; margin-top: 0; }

  .thumb {
    flex-shrink: 0;
    width: 64px;
    height: 64px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: #1f2228;
    cursor: pointer;
    overflow: hidden;
    line-height: 0;
  }
  .thumb:hover { border-color: var(--accent); }
  .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }

  :global(.mcard.selected) {
    border-color: #4f9cff;
    box-shadow: 0 0 0 1px rgb(79 156 255 / 30%), 0 0 16px rgb(79 156 255 / 14%);
  }
</style>
