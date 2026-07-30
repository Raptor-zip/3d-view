<script lang="ts">
  import { dispatchJointAction, robotCards, type JointCard, type RobotCard } from './joints';

  // ⚠ 表示は deg / mm、内部は rad / m。スライダーの値をそのまま渡すと
  //   回転関節が 57 倍動く。ここで必ず変換する。
  const toUi = (j: JointCard) => (j.unit === 'deg' ? (j.value * 180) / Math.PI : j.unit === 'mm' ? j.value * 1000 : j.value);
  const uiLo = (j: JointCard) => (j.unit === 'deg' ? (j.lower * 180) / Math.PI : j.unit === 'mm' ? j.lower * 1000 : j.lower);
  const uiHi = (j: JointCard) => (j.unit === 'deg' ? (j.upper * 180) / Math.PI : j.unit === 'mm' ? j.upper * 1000 : j.upper);
  const fromUi = (j: JointCard, v: number) => (j.unit === 'deg' ? (v * Math.PI) / 180 : j.unit === 'mm' ? v / 1000 : v);

  function onSlide(robot: RobotCard, joint: JointCard, event: Event) {
    const v = Number((event.currentTarget as HTMLInputElement).value);
    dispatchJointAction(robot.id, 'set-value', joint.name, fromUi(joint, v));
  }

  const step = (j: JointCard) => {
    const span = uiHi(j) - uiLo(j);
    return span > 0 ? Math.max(span / 400, 0.01) : 0.01;
  };
  const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));
</script>

{#if $robotCards.length > 0}
  <div id="jointPanel">
    {#each $robotCards as robot (robot.id)}
      <div class="rcard">
        <div class="rtop">
          <b>{robot.name}</b>
          <span class="cnt">{robot.joints.length} 関節</span>
          <button class="rst" title="すべて 0 に戻す" onclick={() => dispatchJointAction(robot.id, 'reset')}>0 に戻す</button>
        </div>
        {#each robot.joints as joint (joint.name)}
          <div class="jrow">
            <label class="jname" for={`j-${robot.id}-${joint.name}`} title={joint.type}>{joint.name}</label>
            <input
              id={`j-${robot.id}-${joint.name}`}
              type="range"
              min={uiLo(joint)}
              max={uiHi(joint)}
              step={step(joint)}
              value={toUi(joint)}
              oninput={(event) => onSlide(robot, joint, event)}
            />
            <span class="jval">{fmt(toUi(joint))}<i>{joint.unit}</i></span>
          </div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  #jointPanel { display: flex; flex-direction: column; gap: 10px; }
  .rcard { background: #1b1e24; border: 1px solid #2a2f38; border-radius: 8px; padding: 8px 10px; }
  .rtop { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .rtop b { font-size: 12px; }
  .cnt { color: #8b93a1; font-size: 11px; margin-right: auto; }
  .rst { font-size: 11px; padding: 2px 8px; border-radius: 6px; border: 1px solid #39404c;
         background: #232830; color: #dfe3ea; cursor: pointer; }
  .rst:hover { background: #2c323c; }
  .jrow { display: grid; grid-template-columns: 96px 1fr 64px; align-items: center; gap: 6px; }
  .jname { font-size: 11px; color: #c8cedb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jval { font-size: 11px; color: #9fb4d8; text-align: right; font-variant-numeric: tabular-nums; }
  .jval i { color: #6d7686; font-style: normal; margin-left: 2px; }
  input[type='range'] { width: 100%; }
</style>
