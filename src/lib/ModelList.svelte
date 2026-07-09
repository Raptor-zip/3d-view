<script lang="ts">
  import { dispatchModelAction, modelCards, selectedModelId, type ModelCard } from './models';

  function setVisible(model: ModelCard, event: Event) {
    dispatchModelAction(model.id, 'set-visible', (event.currentTarget as HTMLInputElement).checked);
  }

  function setOpacity(model: ModelCard, event: Event) {
    dispatchModelAction(model.id, 'set-opacity', Number((event.currentTarget as HTMLInputElement).value) / 100);
  }

  function setPartVisible(model: ModelCard, partIndex: number, event: Event) {
    dispatchModelAction(model.id, 'set-part-visible', {
      partIndex,
      visible: (event.currentTarget as HTMLInputElement).checked,
    });
  }

  function setAllParts(model: ModelCard, visible: boolean) {
    dispatchModelAction(model.id, 'set-all-parts-visible', visible);
  }

  function fmtTri(tri: number) {
    return tri.toLocaleString('en-US');
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
              <span class:wide={detail.wide}>{detail.label} <b>{detail.value}</b></span>
            {/each}
          </div>
        </div>
        {#if !model.isGcode}
          <label class="opacity-row" title="このモデルの不透明度">
            <span>不透明度</span>
            <input
              type="range" min="5" max="100" step="5" value={Math.round(model.opacity * 100)}
              oninput={(event) => setOpacity(model, event)}
            />
            <b>{Math.round(model.opacity * 100)}%</b>
          </label>
          {#if model.parts?.length}
            <div class="parts">
              <div class="parts-head">
                <span>部品</span>
                <button type="button" onclick={() => setAllParts(model, true)}>全表示</button>
                <button type="button" onclick={() => setAllParts(model, false)}>全非表示</button>
              </div>
              <div class="part-list">
                {#each model.parts as part (part.index)}
                  <label class:off={!part.visible} class="part-row" title={part.name}>
                    <input
                      type="checkbox"
                      checked={part.visible}
                      onchange={(event) => setPartVisible(model, part.index, event)}
                    />
                    <span>{part.name}</span>
                    <b>{fmtTri(part.tri)}</b>
                  </label>
                {/each}
              </div>
            </div>
          {/if}
        {/if}
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
  .wide { grid-column: 1 / -1; }

  .opacity-row {
    display: flex; align-items: center; gap: 7px; margin-top: 7px;
    font-size: 11px; color: var(--muted); cursor: pointer;
  }
  .opacity-row input { flex: 1; min-width: 0; }
  .opacity-row b {
    color: var(--fg); font-weight: 500; font-variant-numeric: tabular-nums;
    width: 34px; text-align: right;
  }

  .parts {
    margin-top: 7px;
    border-top: 1px solid var(--line);
    padding-top: 7px;
  }
  .parts-head {
    display: flex; align-items: center; gap: 6px;
    color: var(--muted); font-size: 11px;
  }
  .parts-head span { flex: 1; }
  .parts-head button {
    border: 1px solid var(--line); border-radius: 4px; background: #33373f; color: var(--fg);
    font-size: 10px; padding: 2px 6px; cursor: pointer;
  }
  .parts-head button:hover { border-color: var(--accent); }
  .part-list {
    margin-top: 5px;
    display: flex; flex-direction: column; gap: 3px;
    max-height: 128px; overflow: auto; padding-right: 2px;
  }
  .part-row {
    display: grid; grid-template-columns: 16px minmax(0,1fr) auto; align-items: center; gap: 5px;
    font-size: 11px; color: var(--fg); cursor: pointer;
  }
  .part-row input { margin: 0; }
  .part-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .part-row b {
    color: var(--muted); font-weight: 500; font-variant-numeric: tabular-nums;
    font-size: 10px;
  }
  .part-row.off { opacity: .48; }

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
