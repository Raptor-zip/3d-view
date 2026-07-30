// STEP読み込みの実行基盤：ワーカー並行変換＋変換結果キャッシュ。
//
// 計測（Ryzen系ノート / Chrome, 28MBのアセンブリSTEP）:
//   ReadFile 5.7s / Transfer 33s / メッシュ化 8.8s / GLB書き出し 0.8s
// 時間の7割はOCCTのSTEP→BRep変換そのもので、読み取りモードや静的パラメータ
// (read.surfacecurve.mode / ShapeFix系の抑制) では有意に縮まなかった。
// そこで「同じ計算を二度させない」「他のことを止めない」「複数ファイルは同時に」で速くする:
//   1. 変換はワーカーで実行 → 変換中もUI・スピナー・進捗・他形式の読み込みが動く
//   2. 同一内容(SHA-256)の変換結果GLBを Cache Storage に保存 → 二度目は即表示
//   3. STEPが複数あるときはワーカーを増やして並行変換（1件あたりの時間は変わらない）
import {
  loadOCC, stepToGlb, OCC_VER, MESH_LINEAR_DEFLECTION, MESH_ANGULAR_DEFLECTION,
  type StepProgress, type StepProgressFn, type StepPreviewFn, type StepPreviewInfo,
} from './step-occ';

// ---------- 変換結果キャッシュ（Cache Storage / セキュアコンテキストのみ） ----------
// 端末内に閉じた保存で、外部送信は一切しない。キーは内容ハッシュなのでファイル名や
// 更新日時が変わっても、中身が同じなら再変換しない。
const CACHE_NAME = `step-glb-${OCC_VER}-d${MESH_LINEAR_DEFLECTION}-a${MESH_ANGULAR_DEFLECTION}`;
const CACHE_MAX_ENTRIES = 16;                             // 直近16件だけ残す（古い順に破棄）
const CACHE_MAX_ENTRY_BYTES = 160 * 1024 * 1024;          // 巨大すぎる結果は保存しない

let cachePromise: Promise<Cache | null> | null = null;
function openStepCache(){
  if(cachePromise) return cachePromise;
  cachePromise = (async ()=>{
    try {
      if(typeof caches === 'undefined') return null;      // 非セキュアコンテキスト等
      return await caches.open(CACHE_NAME);
    } catch(error){
      console.warn('STEPキャッシュを開けませんでした（毎回変換します）', error);
      return null;
    }
  })();
  return cachePromise;
}
async function cacheKeyFor(bytes: ArrayBuffer){
  try {
    if(!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = [...new Uint8Array(digest)].map(b=> b.toString(16).padStart(2, '0')).join('');
    return `${location.origin}/__step-glb__/${hex}`;
  } catch(error){
    console.warn('STEPのハッシュ計算に失敗（キャッシュを使いません）', error);
    return null;
  }
}
async function readStepCache(key: string): Promise<ArrayBuffer | null>{
  const cache = await openStepCache();
  if(!cache) return null;
  try {
    const hit = await cache.match(key);
    return hit ? await hit.arrayBuffer() : null;
  } catch(error){
    console.warn('STEPキャッシュの読み出しに失敗', error);
    return null;
  }
}
async function writeStepCache(key: string, glb: ArrayBuffer){
  if(glb.byteLength > CACHE_MAX_ENTRY_BYTES) return;
  const cache = await openStepCache();
  if(!cache) return;
  try {
    await cache.put(key, new Response(glb));              // Response構築時に複製されるので glb はそのまま使える
    const keys = await cache.keys();                      // 挿入順。あふれた分を古い順に捨てる
    for(const old of keys.slice(0, Math.max(0, keys.length - CACHE_MAX_ENTRIES))) await cache.delete(old);
  } catch(error){
    console.warn('STEPキャッシュの保存に失敗（容量不足など）', error);
  }
}

// ---------- ワーカープール ----------
// 1ワーカーあたりのwasmヒープは重いSTEPで1GB近くまで育ち、以後縮まない。
// そのため同時数は控えめにし、ヒープが膨らんだワーカーは仕事の後に作り直す。
const HEAP_RECYCLE_BYTES = 640 * 1024 * 1024;
const IDLE_TERMINATE_MS = 60_000;
function maxWorkers(){
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency || 4;
  if(memory >= 8 && cores >= 8) return 3;
  if(memory >= 4 && cores >= 4) return 2;
  return 1;
}

interface WorkerSlot {
  worker: Worker;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  broken: boolean;
}
const slots: WorkerSlot[] = [];
const waiters: ((slot: WorkerSlot | null)=> void)[] = [];   // null＝ワーカーを用意できず、メインスレッドで実行
let workerUsable = true;      // ワーカー生成やCDN読み込みに失敗したらメインスレッドへ退避
let jobSequence = 0;

function spawnSlot(): WorkerSlot | null {
  try {
    const worker = new Worker(new URL('./step-worker.ts', import.meta.url), { type:'module' });
    const slot: WorkerSlot = { worker, busy:false, idleTimer:null, broken:false };
    worker.onerror = (event)=>{
      console.warn('STEPワーカーが停止しました', event.message || event);
      slot.broken = true;
    };
    slots.push(slot);
    return slot;
  } catch(error){
    console.warn('STEPワーカーを起動できません。メインスレッドで変換します。', error);
    workerUsable = false;
    return null;
  }
}
function disposeSlot(slot: WorkerSlot){
  if(slot.idleTimer) clearTimeout(slot.idleTimer);
  slot.worker.terminate();
  const at = slots.indexOf(slot);
  if(at >= 0) slots.splice(at, 1);
}
function scheduleIdleTerminate(slot: WorkerSlot){
  if(slot.idleTimer) clearTimeout(slot.idleTimer);
  // 待機中のワーカーは一定時間で畳んでメモリを返す（次回は再起動：wasmはHTTPキャッシュから）
  slot.idleTimer = setTimeout(()=>{ if(!slot.busy) disposeSlot(slot); }, IDLE_TERMINATE_MS);
}
function releaseSlot(slot: WorkerSlot, heapBytes?: number){
  slot.busy = false;
  // ヒープが膨らんだワーカーは畳んでメモリを返す（重いSTEP1件で1GB近くまで育つ）
  const recycle = slot.broken || (heapBytes !== undefined && heapBytes > HEAP_RECYCLE_BYTES);
  if(recycle) disposeSlot(slot);
  if(!waiters.length){
    if(!recycle) scheduleIdleTerminate(slot);
    return;
  }
  const next = recycle ? spawnSlot() : slot;
  const waiter = waiters.shift()!;
  if(next) next.busy = true;
  waiter(next);   // 起動できなければ null（呼び出し側がメインスレッドで変換する）
}
function acquireSlot(): Promise<WorkerSlot | null>{
  if(!workerUsable) return Promise.resolve(null);
  const free = slots.find(s=> !s.busy && !s.broken);
  if(free){
    if(free.idleTimer){ clearTimeout(free.idleTimer); free.idleTimer = null; }
    free.busy = true;
    return Promise.resolve(free);
  }
  if(slots.length < maxWorkers()){
    const slot = spawnSlot();
    if(slot){ slot.busy = true; return Promise.resolve(slot); }
    return Promise.resolve(null);
  }
  return new Promise(resolve=> waiters.push(resolve));
}

interface WorkerMessage {
  id?: number;
  type: 'progress' | 'preview' | 'done' | 'error' | 'warm' | 'warmFailed';
  phase?: StepProgress['phase'];
  done?: number;
  total?: number;
  glb?: ArrayBuffer;
  heapBytes?: number;
  message?: string;
}

function convertOnWorker(slot: WorkerSlot, bytes: ArrayBuffer, channel: JobChannel){
  const id = ++jobSequence;
  return new Promise<ArrayBuffer>((resolve, reject)=>{
    const onMessage = (event: MessageEvent<WorkerMessage>)=>{
      const data = event.data;
      if(data.id !== id) return;
      if(data.type === 'progress'){
        channel.onProgress({ phase:data.phase!, done:data.done, total:data.total });
        return;
      }
      if(data.type === 'preview'){
        if(data.glb) channel.onPreview(data.glb, { done:data.done ?? 0, total:data.total ?? 0 });
        return;
      }
      cleanup();
      if(data.type === 'done' && data.glb){ releaseSlot(slot, data.heapBytes); resolve(data.glb); }
      else { releaseSlot(slot, data.heapBytes); reject(new Error(data.message || 'STEPの変換に失敗しました')); }
    };
    const onError = (event: ErrorEvent)=>{
      cleanup();
      slot.broken = true;
      releaseSlot(slot);
      reject(new Error(`STEPワーカーが停止しました: ${event.message || 'unknown'}`));
    };
    const cleanup = ()=>{
      slot.worker.removeEventListener('message', onMessage as EventListener);
      slot.worker.removeEventListener('error', onError as EventListener);
    };
    slot.worker.addEventListener('message', onMessage as EventListener);
    slot.worker.addEventListener('error', onError as EventListener);
    slot.worker.postMessage({ type:'convert', id, bytes }, [bytes]);
  });
}

// ---------- 変換ジョブ（同一内容の二重変換を防ぐ／先読みと共有する） ----------
interface StepJob {
  promise: Promise<ArrayBuffer>;
  latest: StepProgress | null;
  listeners: Set<StepProgressFn>;
  previewListeners: Set<StepPreviewFn>;
  lastPreview: { glb: ArrayBuffer; info: StepPreviewInfo } | null;
  settled: boolean;
}
// step-occ / ワーカーへ渡す通知路。表示側が付いたり離れたりしても同じジョブを共有する。
interface JobChannel {
  onProgress: StepProgressFn;
  onPreview: StepPreviewFn;
}
const jobs = new Map<string, StepJob>();
let inFlight = 0;

// キャッシュ確認もジョブの中で行う。ハッシュ計算とキャッシュ読み出しはどちらも非同期なので、
// 「鍵が決まった直後に同期でジョブを登録」しないと、同じファイルを同時に開いたときに
// 二重変換になる（先読み＋本読みがまさにこの形）。
function startJob(key: string | null, bytes: ArrayBuffer){
  const job: StepJob = {
    promise:null as unknown as Promise<ArrayBuffer>, latest:null, listeners:new Set(),
    previewListeners:new Set(), lastPreview:null, settled:false,
  };
  const channel: JobChannel = {
    onProgress: (p)=>{ job.latest = p; for(const fn of job.listeners) fn(p); },
    onPreview: (glb, info)=>{
      // 表示側がまだ来ていなくても最後の1枚は持っておき、来たときに渡す
      job.lastPreview = { glb, info };
      for(const fn of job.previewListeners) fn(glb, info);
    },
  };
  job.promise = (async ()=>{
    try {
      if(key){
        const cached = await readStepCache(key);
        if(cached){ channel.onProgress({ phase:'cache' }); return cached; }
      }
      inFlight++;
      try {
        const slot = await acquireSlot();
        const glb = slot
          ? await convertOnWorker(slot, bytes, channel)
          // ワーカー不可：従来どおりメインスレッド（変換中は描画も止まるので途中経過は出さない）
          : await stepToGlb(new Uint8Array(bytes), channel.onProgress);
        // 先に保存してからジョブを外す。保存前に外すと、同じファイルを続けて開いたときに再変換になる。
        if(key) await writeStepCache(key, glb);
        return glb;
      } finally {
        inFlight--;
      }
    } finally {
      job.settled = true;
      job.lastPreview = null;      // 途中経過のGLBを抱え込まない
      if(key) jobs.delete(key);    // 結果を保持し続けない（再取得はキャッシュから）
    }
  })();
  if(key) jobs.set(key, job);
  return job;
}

// STEPのバイト列を色付きGLBへ。変換済みならキャッシュから返す。
// onPreview を渡すと、全部品が揃う前の「途中経過」を受け取れる（重いアセンブリの二段表示）。
// 注意: bytes はワーカーへ転送されることがあるため、呼び出し後は参照しないこと。
export async function stepToGlbCached(
  bytes: ArrayBuffer, onProgress?: StepProgressFn, onPreview?: StepPreviewFn,
): Promise<ArrayBuffer>{
  const key = await cacheKeyFor(bytes);
  // 進行中のジョブ（先読みなど）があれば相乗りし、進捗もそのまま受け取る
  const job = (key ? jobs.get(key) : null) || startJob(key, bytes);
  if(onProgress){
    job.listeners.add(onProgress);
    if(job.latest) onProgress(job.latest);
  }
  if(onPreview && !job.settled){
    job.previewListeners.add(onPreview);
    // 先読みで先に走り出したジョブでも、既に出ている途中経過をここで受け取れる
    if(job.lastPreview) onPreview(job.lastPreview.glb, job.lastPreview.info);
  }
  try { return await job.promise; }
  finally {
    if(onProgress) job.listeners.delete(onProgress);
    if(onPreview) job.previewListeners.delete(onPreview);
  }
}

// 表示待ちのSTEPを先に変換し始める。空きが出るたびに次を投入し、ワーカーを遊ばせない。
// 一度に読み込むファイルはワーカー数＋1までなので、巨大STEPが並んでもメモリは膨らまない。
// 失敗はここでは黙って捨て、実際に表示する段でもう一度報告させる。
export async function prestartStepFiles(files: File[]){
  for(const file of files){
    while(inFlight >= maxWorkers()) await new Promise(resolve=> setTimeout(resolve, 200));
    try {
      const bytes = await file.arrayBuffer();
      const key = await cacheKeyFor(bytes);
      if(key && jobs.has(key)) continue;
      startJob(key, bytes).promise.catch(()=>{ /* 実読み込み時に報告する */ });
    } catch(error){
      console.warn('STEPの先読みに失敗', error);
    }
  }
}

// STEPを開くと分かった時点でwasmを取り始める（初回のみ ~13MB、以降はブラウザキャッシュ）。
let warmed = false;
export function warmupStepEngine(){
  if(warmed) return;
  warmed = true;
  (async ()=>{
    const slot = await acquireSlot();
    if(!slot){
      loadOCC().catch(error=> console.warn('CADエンジンの先読みに失敗（読み込み時に再試行します）', error));
      return;
    }
    // 成否どちらでもスロットを必ず返す（返し忘れるとプールの枠が1つ死ぬ）。
    const finish = (message?: string)=>{
      slot.worker.removeEventListener('message', onMessage as EventListener);
      slot.worker.removeEventListener('error', onError as EventListener);
      if(message) console.warn('CADエンジンの先読みに失敗（読み込み時に再試行します）', message);
      releaseSlot(slot);
    };
    const onMessage = (event: MessageEvent<WorkerMessage>)=>{
      if(event.data.type !== 'warm' && event.data.type !== 'warmFailed') return;
      finish(event.data.type === 'warmFailed' ? event.data.message : undefined);
    };
    const onError = (event: ErrorEvent)=>{ slot.broken = true; finish(event.message || 'worker error'); };
    slot.worker.addEventListener('message', onMessage as EventListener);
    slot.worker.addEventListener('error', onError as EventListener);
    slot.worker.postMessage({ type:'warmup' });
  })();
}
