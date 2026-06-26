import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as fflate from 'three/addons/libs/fflate.module.js';
import { notify } from './lib/notifications';
import { modelCards, selectedModelId as selectedModelIdStore } from './lib/models';

// ---------- 型定義 ----------
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
  interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  }
  interface DataTransferItem {
    // File System Access API：ドロップ要素のハンドル取得（lib.dom 未収載）。
    getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>;
  }
}

interface GcodeHeader {
  printTime?: string;
  filLen?: number;
  filWeight?: number;
  layerNum?: number;
}
interface SlicedPlate {
  total_predication?: number;
  warning_message?: string;
  feature_type_times?: Record<string, number>;
}
interface ResultJson {
  sliced_plates?: SlicedPlate[];
  layer_height?: number;
  wall_loops?: number;
  sparse_infill_density?: number;
}
interface FeatureData { segs: number[]; layers: number[]; feed: number[]; ev: number[]; len: number[]; }
interface ParsedGcode {
  feats: Map<string, FeatureData>;
  travel: { segs: number[]; layers: number[] };
  nLayers: number;
  header: GcodeHeader;
  bbox: { min: number[]; max: number[] };
}
interface LineObj {
  feature: string;
  obj: THREE.LineSegments;
  mat: THREE.LineBasicMaterial;
  color: number;
  prefix: Uint32Array;
  nSeg: number;
  layers: number[];
  feed: number[];
  ev: number[];
  len: number[];
  pos: Float32Array;
}
interface PreviousState {
  color: number;
  visible: boolean;
  curLayer?: number;
  featVisible: Map<string, boolean> | null;
  index: number;
  id: number;
  selected: boolean;
}
interface LoadOptions {
  name?: string;
  progress?: string;
  sourceKey?: string;
  sourceUrl?: string;
  previous?: PreviousState | null;
}
interface MeasureStart {
  point: THREE.Vector3;
  model: Model | undefined;
}
interface DirFile { path: string; file: File; }
interface BrowserDirectoryEntry {
  id: number;
  handle: FileSystemDirectoryHandle;
  files: Map<string, string>;
  modelCount: number;
  syncing: boolean;
  timer: ReturnType<typeof setInterval> | null;
  watch: boolean;
}
interface Model {
  id: number;
  name: string;
  group: THREE.Group;
  geometry: THREE.BufferGeometry;
  color: number;
  visible: boolean;
  size: THREE.Vector3;
  tri: number;
  vert: number;
  vol: number;
  selectionBox: THREE.Box3Helper;
  label: THREE.Sprite;
  thumb?: string | null;
  sourceKey?: string;
  sourceUrl?: string;
  // メッシュモデル専用
  mesh?: THREE.Mesh;
  wire?: THREE.LineSegments | null | false;
  edges?: THREE.LineSegments | null | false;
  box?: THREE.Box3Helper;
  backface?: THREE.Mesh;
  mat?: THREE.MeshStandardMaterial;
  // G-codeモデル専用
  isGcode?: boolean;
  lineObjs?: LineObj[];
  travelObj?: THREE.LineSegments | null;
  nLayers?: number;
  curLayer?: number;
  featVisible?: Map<string, boolean>;
  header?: GcodeHeader;
  resultJson?: ResultJson | null;
  _overhangDone?: boolean;
  _flowPeak?: number;
}
type StateBoolKey = 'solid' | 'wire' | 'edges' | 'normal' | 'backface' | 'opacity' | 'clip' | 'clipFlip' | 'box' | 'labels';

// ---------- シーン基盤 ----------
const viewEl = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer:true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6);
camera.up.set(0,0,1);            // Z-up（CAD/STL慣習に合わせる）
camera.position.set(120,-120,90);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;  // ドラッグ時の慣性アニメを無効化
// ズーム/パンは target（回転中心）までの距離に比例するため、target に寄るほど増分が
// 小さくなり「それ以上寄れない／離れると移動量が落ちる」状態になる。カーソル方向へ
// ズームして target も追従させることで、見ている箇所へ無制限に寄れるようにする。
controls.zoomToCursor = true;
controls.minDistance = 0.01;

// ライト
scene.add(new THREE.AmbientLight(0xffffff, 0.55));
const key = new THREE.DirectionalLight(0xffffff, 0.9); key.position.set(1,1.4,0.8); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.5); fill.position.set(-1,-0.6,-0.8); scene.add(fill);
const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 0.4); scene.add(hemi);

// グリッド・軸
let grid: THREE.GridHelper | null = null, gridVisible = true;
const axes = new THREE.AxesHelper(50); scene.add(axes);
function rebuildGrid(maxDim: number){
  if(grid){ scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const step = 10;
  const half = Math.max(Math.ceil((maxDim*1.5)/2/step)*step, 40);
  const size = half*2, divisions = size/step;
  grid = new THREE.GridHelper(size, divisions, 0x555a63, 0x33373f);
  grid.rotation.x = Math.PI/2;   // XZ平面 → XY平面（Z-upの床）
  grid.visible = gridVisible;
  scene.add(grid);
  axes.scale.setScalar(Math.max(maxDim*0.6, 30) / 50);
}
rebuildGrid(80);

// ---------- 共有マテリアル ----------
const clipPlane = new THREE.Plane(new THREE.Vector3(0,0,-1), 0);
const normalMat = new THREE.MeshNormalMaterial({ side:THREE.DoubleSide });
const backfaceRed = new THREE.MeshBasicMaterial({ color:0xff3b30, side:THREE.BackSide });
const PALETTE = [0x4f9cff, 0xffb347, 0x7bd88f, 0xff6b9d, 0xb888ff, 0xbfc4cc, 0x57d2d2, 0xe0c84d];

// G-code フィーチャ別カラー（bambu-slice の matplotlib 凡例に概ね合わせる）
const FEATURE_COLORS: Record<string, number> = {
  'Outer wall':            0xff6b3d,
  'Inner wall':            0xffb347,
  'Overhang wall':         0xff3b30,
  'Sparse infill':         0xb888ff,
  'Internal solid infill': 0x4f9cff,
  'Top surface':           0x57d2d2,
  'Bottom surface':        0x7bd88f,
  'Bridge':                0xff3bd0,
  'Internal bridge':       0xc23bff,
  'Skirt':                 0x9aa0a8,
  'Brim':                  0x9aa0a8,
  'Support':               0x6f7680,
  'Support interface':     0x8a9098,
  'Gap infill':            0xe0c84d,
  'Custom':                0x707782,
};
const featureColor = (name: string)=> FEATURE_COLORS[name] ?? 0xbfc4cc;

// ---------- 状態 ----------
const models: Model[] = [];   // { name, group, mesh, wire, edges, box, backface, geometry, mat, color, visible, size, tri, vert, vol, sourceKey }
let colorCursor = 0;
let modelIdCursor = 0;
const state = { solid:true, wire:false, edges:false, normal:false, backface:false, opacity:false, clip:false, clipFlip:false, box:false, labels:true, layout:'overlay', layoutGap:10 };
let selectedModelId: number | null = null;

function labelText(name: string){
  const text = name.split('/').pop() || name;
  return text.length > 42 ? text.slice(0,39)+'…' : text;
}
function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number){
  const r = Math.min(radius, width/2, height/2);
  ctx.beginPath(); ctx.moveTo(x+r,y); ctx.arcTo(x+width,y,x+width,y+height,r); ctx.arcTo(x+width,y+height,x,y+height,r); ctx.arcTo(x,y+height,x,y,r); ctx.arcTo(x,y,x+width,y,r); ctx.closePath();
}
function createModelLabel(name: string, size: THREE.Vector3, color: number){
  const text = labelText(name);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = '600 28px system-ui, sans-serif';
  const paddingX=20, paddingY=12, width=Math.min(Math.ceil(ctx.measureText(text).width)+paddingX*2, 720), height=52;
  canvas.width=width; canvas.height=height;
  ctx.font = '600 28px system-ui, sans-serif';
  roundedRect(ctx, 1, 1, width-2, height-2, 10); ctx.fillStyle='rgba(20,22,27,.78)'; ctx.fill();
  ctx.lineWidth=2; ctx.strokeStyle='#'+color.toString(16).padStart(6,'0'); ctx.stroke();
  ctx.fillStyle='#f5f7fa'; ctx.textBaseline='middle'; ctx.fillText(text, paddingX, height/2);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map:texture, transparent:true, depthTest:false, depthWrite:false });
  const sprite = new THREE.Sprite(material);
  const scaleY = Math.max(3.5, Math.min(10, Math.max(size.x,size.y,size.z)*0.12));
  sprite.scale.set(scaleY*width/height, scaleY, 1);
  sprite.position.set(0,0,size.z + scaleY*0.25); sprite.center.set(0.5,0);
  sprite.renderOrder = 8;
  return sprite;
}
function disposeModelDecorations(m: Model){
  if(m.selectionBox){ m.selectionBox.geometry.dispose(); (m.selectionBox.material as THREE.Material).dispose(); }
  if(m.label){ m.label.material.map?.dispose(); m.label.material.dispose(); }
}
function refreshModelLabel(m: Model){
  if(!m.label) return;
  m.group.remove(m.label);
  m.label.material.map?.dispose(); m.label.material.dispose();
  m.label = createModelLabel(m.name, m.size, m.color);
  m.group.add(m.label);
}
function updateModelDecorations(){
  for(const m of models){
    if(m.selectionBox) m.selectionBox.visible = m.visible && m.id===selectedModelId;
    if(m.label){
      m.label.visible = state.labels && m.visible;
      m.label.material.opacity = selectedModelId==null || m.id===selectedModelId ? 1 : 0.62;
    }
  }
}
function setSelectedModel(id: number | null){
  selectedModelId = id;
  selectedModelIdStore.set(id);
  updateModelDecorations();
}

// ---------- ファイル読み込み ----------
const busy = document.getElementById('busy')!;
const busyText = document.getElementById('busyText')!;
const showBusy = (s: string | null)=>{ busy.classList.toggle('show', !!s); if(s) busyText.textContent = s; };
const nextFrame = ()=> new Promise(r=> requestAnimationFrame(()=> requestAnimationFrame(r)));

document.getElementById('openBtn')!.onclick = ()=> document.getElementById('fileInput')!.click();
document.getElementById('heroOpenBtn')!.onclick = ()=> document.getElementById('fileInput')!.click();
document.getElementById('fileInput')!.onchange = (e)=>{ loadFiles([...(e.target as HTMLInputElement).files!]); (e.target as HTMLInputElement).value=''; };
// 監視（自動更新）は File System Access API 依存で Chrome/Edge のみ。
// 未対応ブラウザ（Safari/Firefox）では監視ボタンを出さず、「フォルダーを開く（一回）」へ誘導する。
// 自動更新（1秒ポーリング）は File System Access API の永続ハンドルが要る＝Chrome/Edge のみ。
// 「フォルダーを開く」は対応ブラウザではハンドル取得（フォルダーごとに自動更新トグル可）、
// 非対応ブラウザ(Safari/Firefox)では webkitdirectory による一回読み込みへ自動フォールバックする。
const WATCH_SUPPORTED = typeof window.showDirectoryPicker === 'function';
document.getElementById('openFolderBtn')!.onclick = ()=>
  WATCH_SUPPORTED ? selectBrowserDirectory() : document.getElementById('folderInput')!.click();
document.getElementById('folderInput')!.onchange = async (e)=>{
  const files = [...(e.target as HTMLInputElement).files!]; (e.target as HTMLInputElement).value='';
  if(!files.length) return;
  await loadFiles(files);
  if(models.length > 1) setLayout('grid', true);
};

const drop = document.getElementById('drop')!;
window.addEventListener('dragover', e=>{ e.preventDefault(); drop.classList.add('show'); });
window.addEventListener('dragleave', e=>{ if(e.relatedTarget===null) drop.classList.remove('show'); });
// FileSystemEntry（webkitGetAsEntry 由来）を再帰で全ファイルへ展開する。監視非対応ブラウザ用の一回読み込み。
function readEntryFile(entry: FileSystemFileEntry){
  return new Promise<File>((resolve, reject)=> entry.file(resolve, reject));
}
function readAllDirectoryEntries(reader: FileSystemDirectoryReader){
  return new Promise<FileSystemEntry[]>((resolve, reject)=>{
    const all: FileSystemEntry[] = [];
    const read = ()=> reader.readEntries(batch=>{
      if(!batch.length){ resolve(all); return; }   // readEntries は分割で返すので空になるまで読む
      all.push(...batch); read();
    }, reject);
    read();
  });
}
async function collectDroppedEntryFiles(entry: FileSystemEntry): Promise<File[]>{
  if(entry.isFile) return [await readEntryFile(entry as FileSystemFileEntry)];
  if(entry.isDirectory){
    const children = await readAllDirectoryEntries((entry as FileSystemDirectoryEntry).createReader());
    const nested = await Promise.all(children.map(collectDroppedEntryFiles));
    return nested.flat();
  }
  return [];
}

window.addEventListener('drop', async e=>{
  e.preventDefault(); drop.classList.remove('show');
  const items = e.dataTransfer?.items ? [...e.dataTransfer.items] : [];
  if(!items.length){   // DataTransferItem 非対応：従来どおり平坦なファイルを読む
    if(e.dataTransfer?.files.length) await loadFiles([...e.dataTransfer.files]);
    return;
  }
  // DataTransferItem は最初の await でクリアされるため、ここで同期的に全て取り出しておく。
  const looseFiles: File[] = [];
  const dirTasks: Promise<unknown>[] = [];
  for(const item of items){
    if(item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if(entry && entry.isDirectory){
      if(WATCH_SUPPORTED && item.getAsFileSystemHandle){
        // 対応ブラウザ：フォルダーごと監視対象（自動更新つき）に登録。
        dirTasks.push(item.getAsFileSystemHandle().then(h=>
          h && h.kind === 'directory' ? addBrowserDirectoryHandle(h as FileSystemDirectoryHandle) : null
        ).catch(err=> console.error('フォルダーのドロップに失敗', err)));
      } else {
        // 非対応ブラウザ：再帰読み込みで一回だけ取り込む。
        dirTasks.push(collectDroppedEntryFiles(entry).then(files=>{ if(files.length) return loadFiles(files); }));
      }
    } else {
      const f = item.getAsFile();
      if(f) looseFiles.push(f);
    }
  }
  if(looseFiles.length) await loadFiles(looseFiles);
  await Promise.all(dirTasks);
});

async function loadFiles(files: File[]){
  document.getElementById('hint')!.style.display = 'none';
  // バッチ内に result.json があれば gcode の統計として使う
  let resultJson: ResultJson | null = null;
  const rf = files.find(f=> /(^|\/)result\.json$/i.test(f.name) || f.name.toLowerCase()==='result.json');
  if(rf){ try { resultJson = JSON.parse(await rf.text()); } catch(e){ console.warn('result.json 解析失敗', e); } }
  for(let i=0;i<files.length;i++){
    await loadLocalFile(files[i], resultJson, { progress:`${i+1}/${files.length}` });
  }
  showBusy(null);
}

// File / FileSystemFileHandle の両方から使う共通読込。sourceKey があると成功後に既存モデルを置換する。
async function loadLocalFile(file: File, resultJson: ResultJson | null, options: LoadOptions = {}){
  const name = options.name || file.name;
  const ext = name.split('.').pop()!.toLowerCase();
  if(ext === 'json') return true;  // result.json は呼び出し側で処理済み
  const mb = (file.size/1048576).toFixed(1);
  const prefix = options.progress ? ` (${options.progress})` : '';
  showBusy(`読み込み中${prefix}… ${name} (${mb} MB)`);
  await nextFrame();
  try {
    if(ext === 'gcode'){
      const parsed = parseGcode(await file.text());
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(options.sourceKey);
      addGcode(name, parsed, resultJson, { sourceKey:options.sourceKey, previous });
      return true;
    }
    if(ext === '3mf'){
      const buffer = await file.arrayBuffer();
      const ex = extractGcodeFrom3mf(buffer);
      if(ex){   // スライス済み3mf（メッシュ無し）→ 内蔵gcodeを表示
        const parsed = parseGcode(ex.text);
        if(ex.weight && !parsed.header.filWeight) parsed.header.filWeight = ex.weight;
        showBusy(`配置中… ${name}`); await nextFrame();
        const previous = takeSourceState(options.sourceKey);
        addGcode(name, parsed, resultJson || ex.resultJson, { sourceKey:options.sourceKey, previous });
        return true;
      }
      const geometry = await parseBuffer(buffer, name);
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(options.sourceKey);
      addModel(name, geometry, { sourceKey:options.sourceKey, previous });
      return true;
    }
    const geometry = await parseFile(file);
    showBusy(`配置中… ${name}`); await nextFrame();
    const previous = takeSourceState(options.sourceKey);
    addModel(name, geometry, { sourceKey:options.sourceKey, previous });
    return true;
  } catch(err){
    console.error(err);
    notify(`読み込みエラー\n${name}\n${(err as Error).message}`, { level:'error', duration:9000 });
    return false;
  }
}

async function parseFile(file: File){
  return parseBuffer(await file.arrayBuffer(), file.name);
}
async function parseBuffer(buf: ArrayBuffer, name: string){
  const ext = name.split('.').pop()!.toLowerCase();
  let geometry: THREE.BufferGeometry | null = null, object: THREE.Object3D | null = null;
  if(ext === 'stl')       geometry = new STLLoader().parse(buf);
  else if(ext === 'obj')  object = new OBJLoader().parse(new TextDecoder().decode(buf));
  else if(ext === '3mf')  object = new ThreeMFLoader().parse(buf);
  else if(ext === 'step' || ext === 'stp') geometry = await loadStep(buf);
  else if(ext === 'glb' || ext === 'gltf') geometry = await loadGltf(buf);
  else throw new Error('未対応の形式: .'+ext);
  if(object && !geometry) geometry = mergeObject(object);
  if(!geometry || !geometry.attributes.position) throw new Error('ジオメトリを取得できませんでした');
  return geometry;
}

function sourceKeyFor(url: string){ return new URL(url, location.href).href; }
function sourceNameFor(url: string){
  const pathname = new URL(url, location.href).pathname;
  return decodeURIComponent(pathname.split('/').pop()!) || 'model';
}
function takeSourceState(sourceKey: string | undefined): PreviousState | null {
  if(!sourceKey) return null;
  const old = models.find(m=>m.sourceKey === sourceKey);
  if(!old) return null;
  const keep = {
    color: old.color, visible: old.visible, curLayer: old.curLayer,
    featVisible: old.featVisible ? new Map(old.featVisible) : null, index:models.indexOf(old), id:old.id, selected:old.id===selectedModelId,
  };
  removeModel(old);
  return keep;
}

// URL(同一オリジンのHTTP配信)からモデルを取得して読み込む。sourceKey が同じ場合は成功後に置換する。
async function loadUrl(url: string, options: LoadOptions = {}){
  document.getElementById('hint')!.style.display = 'none';
  const sourceKey = options.sourceKey || sourceKeyFor(url);
  const name = options.name || sourceNameFor(url);
  showBusy(`読み込み中… ${name}`);
  await nextFrame();
  try {
    const res = await fetch(url, { cache:'no-store' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    if(name.split('.').pop()!.toLowerCase() === 'gcode'){
      const parsed = parseGcode(await res.text());
      // 同ディレクトリの result.json を試行（無ければ無視）
      let resultJson: ResultJson | null = null;
      try {
        const rjUrl = url.replace(/[^/]+$/, 'result.json');
        const r = await fetch(rjUrl, { cache:'no-store' }); if(r.ok) resultJson = await r.json();
      } catch(e){ /* 無くてよい */ }
      const previous = takeSourceState(sourceKey);
      addGcode(name, parsed, resultJson, { sourceKey, sourceUrl:url, previous });
    } else {
      const ab = await res.arrayBuffer();
      if(name.split('.').pop()!.toLowerCase() === '3mf'){
        const ex = extractGcodeFrom3mf(ab);
        if(ex){   // スライス済み3mf（メッシュ無し）→ 内蔵gcodeを表示
          const parsed = parseGcode(ex.text);
          if(ex.weight && !parsed.header.filWeight) parsed.header.filWeight = ex.weight;
          const previous = takeSourceState(sourceKey);
          addGcode(name, parsed, ex.resultJson, { sourceKey, sourceUrl:url, previous });
          showBusy(null); return;
        }
      }
      const geometry = await parseBuffer(ab, name);
      const previous = takeSourceState(sourceKey);
      addModel(name, geometry, { sourceKey, sourceUrl:url, previous });
    }
  } catch(err){
    console.error(err);
    notify(`読み込みエラー\n${name}\n${(err as Error).message}`, { level:'error', duration:9000 });
  }
  showBusy(null);
}

const folderStatus = document.getElementById('folderStatus')!;

// ブラウザが明示的に許可した File System Access API のフォルダー監視。
// 実パスを露出させず、FileHandle から最新の File を取り直して差分だけ置換する。
const BROWSER_DIRECTORY_EXTENSIONS = new Set(['stl','step','stp','obj','3mf','glb','gltf','gcode']);
const browserDirectories = new Map<number, BrowserDirectoryEntry>();
let browserDirectorySequence = 0;
function parentPath(path: string){ const p=path.lastIndexOf('/'); return p<0 ? '' : path.slice(0,p); }
function browserSourceKey(entry: BrowserDirectoryEntry, path: string){ return `browser-directory:${entry.id}:${path}`; }
async function collectBrowserDirectoryFiles(handle: FileSystemDirectoryHandle, prefix=''): Promise<DirFile[]> {
  const found: DirFile[] = [];
  for await(const [name, child] of handle.entries()){
    const path = prefix ? `${prefix}/${name}` : name;
    if(child.kind === 'directory'){
      found.push(...await collectBrowserDirectoryFiles(child as FileSystemDirectoryHandle, path));
      continue;
    }
    const ext = name.split('.').pop()!.toLowerCase();
    if(!BROWSER_DIRECTORY_EXTENSIONS.has(ext) && name.toLowerCase() !== 'result.json') continue;
    found.push({ path, file:await (child as FileSystemFileHandle).getFile() });
  }
  return found;
}
async function syncBrowserDirectory(entry: BrowserDirectoryEntry){
  if(entry.syncing) return;
  entry.syncing = true;
  try {
    const found = await collectBrowserDirectoryFiles(entry.handle);
    const resultByDirectory = new Map<string, { value: ResultJson; stamp: string }>();
    for(const item of found){
      if(item.file.name.toLowerCase() !== 'result.json') continue;
      try {
        resultByDirectory.set(parentPath(item.path), {
          value:JSON.parse(await item.file.text()), stamp:`${item.file.lastModified}:${item.file.size}`,
        });
      } catch(error){ console.warn(`result.json 解析失敗: ${item.path}`, error); }
    }
    const modelFiles = found.filter(item=> BROWSER_DIRECTORY_EXTENSIONS.has(item.file.name.split('.').pop()!.toLowerCase()));
    const next = new Map<string, string>();
    for(const item of modelFiles){
      const sourceKey = browserSourceKey(entry, item.path);
      const result = resultByDirectory.get(parentPath(item.path));
      const ext = item.file.name.split('.').pop()!.toLowerCase();
      // result.json の変更では G-code の統計も更新する。
      const stamp = `${item.file.lastModified}:${item.file.size}${ext==='gcode' ? `:${result?.stamp||''}` : ''}`;
      next.set(sourceKey, stamp);
    }
    for(const sourceKey of entry.files.keys()){
      if(!next.has(sourceKey)){
        const old = models.find(model=>model.sourceKey===sourceKey);
        if(old) removeModel(old);
      }
    }
    for(const item of modelFiles){
      const sourceKey = browserSourceKey(entry, item.path);
      if(entry.files.get(sourceKey) === next.get(sourceKey)) continue;
      const result = resultByDirectory.get(parentPath(item.path));
      await loadLocalFile(item.file, result?.value || null, { sourceKey, name:item.path });
    }
    entry.files = next;
    entry.modelCount = modelFiles.length;
    updateBrowserDirectoryStatus();
  } catch(error){
    console.error(error);
    folderStatus.textContent = `フォルダー監視に失敗: ${(error as Error).message}`;
  } finally {
    entry.syncing = false;
    showBusy(null);
  }
}
const folderList = document.getElementById('folderList')!;
// フォルダーを取り除く：タイマーを止め、そのフォルダー由来のモデルを全て撤去してから一覧から外す。
function stopBrowserDirectory(entry: BrowserDirectoryEntry){
  if(entry.timer){ clearInterval(entry.timer); entry.timer = null; }
  for(const sourceKey of entry.files.keys()){
    const old = models.find(model=> model.sourceKey === sourceKey);
    if(old) removeModel(old);
  }
  browserDirectories.delete(entry.id);
  updateBrowserDirectoryStatus();
}
// 自動更新（1秒ポーリング）のON/OFFをフォルダー単位で切り替える。OFFでもモデルは表示したまま。
function setBrowserDirectoryWatch(entry: BrowserDirectoryEntry, on: boolean){
  entry.watch = on;
  if(on){
    if(!entry.timer) entry.timer = setInterval(()=> syncBrowserDirectory(entry), 1000);
    syncBrowserDirectory(entry);   // ONにした瞬間に一度だけ取り込む
  } else if(entry.timer){
    clearInterval(entry.timer); entry.timer = null;
  }
  updateBrowserDirectoryStatus();
}
function renderBrowserDirectoryList(){
  const entries = [...browserDirectories.values()];
  folderList.textContent = '';
  for(const entry of entries){
    const row = document.createElement('div');
    row.className = 'folderItem';
    const name = document.createElement('span');
    name.className = 'fi-name'; name.textContent = entry.handle.name; name.title = entry.handle.name;
    const count = document.createElement('span');
    count.className = 'fi-count'; count.textContent = `${entry.modelCount || 0}件`;
    const watch = document.createElement('label');
    watch.className = 'fi-watch'; watch.title = `「${entry.handle.name}」を1秒ごとに自動更新`;
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.checked = entry.watch !== false;
    cb.onchange = ()=> setBrowserDirectoryWatch(entry, cb.checked);
    const wlabel = document.createElement('span'); wlabel.textContent = '自動更新';
    watch.append(cb, wlabel);
    const stop = document.createElement('button');
    stop.className = 'fi-stop'; stop.textContent = '削除'; stop.title = `「${entry.handle.name}」と由来モデルを取り除く`;
    stop.onclick = ()=> stopBrowserDirectory(entry);
    row.append(name, count, watch, stop);
    folderList.append(row);
  }
}
function updateBrowserDirectoryStatus(){
  const entries = [...browserDirectories.values()];
  const total = entries.reduce((sum, entry)=> sum + (entry.modelCount || 0), 0);
  renderBrowserDirectoryList();
  if(!entries.length){
    folderStatus.textContent = WATCH_SUPPORTED
      ? 'ファイル／フォルダーをドラッグ&ドロップ、または上のボタンで開きます。開いたフォルダーは既定で自動更新（行ごとにオフ可）。'
      : 'ファイル／フォルダーをドラッグ&ドロップ、または上のボタンで開きます。';
    return;
  }
  const watching = entries.filter(entry=> entry.watch !== false).length;
  folderStatus.textContent = watching
    ? `${entries.length} フォルダー・合計 ${total} 件を表示中（${watching} フォルダーを1秒ごとに自動更新）。`
    : `${entries.length} フォルダー・合計 ${total} 件を表示中（自動更新オフ）。`;
}
// FileSystemDirectoryHandle を監視対象に登録する。ボタン選択／ドロップの両方から使う。
async function addBrowserDirectoryHandle(handle: FileSystemDirectoryHandle){
  for(const entry of browserDirectories.values()){
    if(await handle.isSameEntry(entry.handle)){
      folderStatus.textContent = `「${handle.name}」はすでに監視中です。`;
      return false;
    }
  }
  const entry: BrowserDirectoryEntry = { id:++browserDirectorySequence, handle, files:new Map(), modelCount:0, syncing:false, timer:null, watch:true };
  browserDirectories.set(entry.id, entry);
  showBusy(`フォルダーを読み込み中… ${handle.name}`);
  try {
    await syncBrowserDirectory(entry);
    entry.timer = setInterval(()=> syncBrowserDirectory(entry), 1000);
    if(models.length > 1) setLayout('grid', true);
    return true;
  } finally {
    showBusy(null);
  }
}
async function selectBrowserDirectory(){
  if(!window.showDirectoryPicker){
    // 通常はボタン側で振り分けるため到達しないが、安全のため一回読み込みへフォールバック。
    folderStatus.textContent = 'このブラウザは自動更新に未対応です。フォルダーを一回読み込みます。';
    document.getElementById('folderInput')!.click();
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode:'read' });
    await addBrowserDirectoryHandle(handle);
  } catch(error){
    if((error as Error).name === 'AbortError') return;  // 選択キャンセル
    console.error(error);
    folderStatus.textContent = `フォルダーを開けませんでした: ${(error as Error).message}`;
  }
}

function mergeObject(root: THREE.Object3D): THREE.BufferGeometry | null {
  const geoms: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse(o=>{
    const om = o as THREE.Mesh;
    if(om.isMesh && om.geometry){
      const g = om.geometry.clone();
      g.applyMatrix4(om.matrixWorld);
      g.deleteAttribute('uv'); g.deleteAttribute('color');
      geoms.push(g.index ? g.toNonIndexed() : g);
    }
  });
  if(geoms.length === 0) return null;
  let total = 0; geoms.forEach(g=> total += g.attributes.position.count);
  const pos = new Float32Array(total*3);
  let off = 0;
  geoms.forEach(g=>{ pos.set(g.attributes.position.array, off); off += g.attributes.position.array.length; });
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos,3));
  merged.computeVertexNormals();
  return merged;
}

// STEP/glTF の色を焼き込む際の彩度倍率（1=無加工）。PBR＋環境光で寝るのを補正。
const COLOR_SATURATION: number = 1.4;

// glTF/GLB を単一ジオメトリへ統合しつつ、各メッシュのマテリアル色（または頂点色）を
// 頂点カラー属性に焼き込む。glTFのbaseColorはリニア空間なのでそのまま使える。
function mergeColored(root: THREE.Object3D): THREE.BufferGeometry | null {
  const geoms: THREE.BufferGeometry[] = []; let hasColor = false;
  root.updateMatrixWorld(true);
  root.traverse(o=>{
    const om = o as THREE.Mesh;
    if(!om.isMesh || !om.geometry) return;
    const src = om.geometry.index ? om.geometry.toNonIndexed() : om.geometry.clone();
    src.applyMatrix4(om.matrixWorld);
    src.deleteAttribute('uv');
    const n = src.attributes.position.count;
    const col = new Float32Array(n*3);
    const mat = (Array.isArray(om.material) ? om.material[0] : om.material) as THREE.MeshStandardMaterial;
    const existing = src.attributes.color;
    if(existing){
      hasColor = true;
      for(let i=0;i<n;i++){ col[i*3]=existing.getX(i); col[i*3+1]=existing.getY(i); col[i*3+2]=existing.getZ(i); }
    } else {
      const c = (mat && mat.color) ? mat.color : new THREE.Color(0.8,0.8,0.8);
      if(mat && mat.color) hasColor = true;
      for(let i=0;i<n;i++){ col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b; }
    }
    src.setAttribute('color', new THREE.BufferAttribute(col,3));
    const keep = new THREE.BufferGeometry();
    keep.setAttribute('position', src.attributes.position.clone());
    keep.setAttribute('color', src.attributes.color);
    if(src.attributes.normal) keep.setAttribute('normal', src.attributes.normal.clone());
    geoms.push(keep);
  });
  if(geoms.length === 0) return null;
  let total = 0; geoms.forEach(g=> total += g.attributes.position.count);
  const pos = new Float32Array(total*3), col = new Float32Array(total*3);
  let hasN = geoms.every(g=>g.attributes.normal);
  const nor = hasN ? new Float32Array(total*3) : null;
  let off = 0;
  geoms.forEach(g=>{
    pos.set(g.attributes.position.array, off);
    col.set(g.attributes.color.array, off);
    if(hasN) nor!.set(g.attributes.normal.array, off);
    off += g.attributes.position.array.length;
  });
  // 彩度ブースト：データ(baseColor)は正しいが PBR＋環境光で色が寝るため、
  // 色相を保ったまま luma 基準で彩度だけ少し上げて鮮やかにする。
  if(hasColor && COLOR_SATURATION !== 1){
    for(let i=0;i<col.length;i+=3){
      const r=col[i], g=col[i+1], b=col[i+2];
      const y = 0.2126*r + 0.7152*g + 0.0722*b;
      col[i]   = Math.min(1, Math.max(0, y + (r-y)*COLOR_SATURATION));
      col[i+1] = Math.min(1, Math.max(0, y + (g-y)*COLOR_SATURATION));
      col[i+2] = Math.min(1, Math.max(0, y + (b-y)*COLOR_SATURATION));
    }
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos,3));
  if(hasColor) merged.setAttribute('color', new THREE.BufferAttribute(col,3));
  if(hasN) merged.setAttribute('normal', new THREE.BufferAttribute(nor!,3)); else merged.computeVertexNormals();
  return merged;
}

// glTF/GLB: three.js GLTFLoader（色・マテリアルをネイティブ対応）。
// STEPを色付きで見たい場合は step2glb.mjs で GLB に変換してから読む。
async function loadGltf(buf: ArrayBuffer | { buffer: ArrayBuffer }){
  showBusy('glTF読み込み中…');
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buf instanceof ArrayBuffer ? buf : buf.buffer, '');
  const g = mergeColored(gltf.scene);
  if(!g) throw new Error('glTFにメッシュがありません');
  return g;
}

// STEP: フル版OCCT (opencascade.js) をブラウザ内で動かし、面ごと色まで解決して
// 色付き glTF をメモリ上に生成 → GLTFLoader で読む。occt-import-js は面色を読めず
// ほぼ単色になるため、色を出すにはフルOCCTが要る（詳細は README / step2glb.mjs）。
// wasm は約48MB(gzip後~13MB)で初回のみCDNから取得・以降ブラウザキャッシュ。
const OCC_VER = '2.0.0-beta.b5ff984';
const OCC_BASE = `https://cdn.jsdelivr.net/npm/opencascade.js@${OCC_VER}/dist/`;
let occPromise: Promise<any> | null = null;
function loadOCC(): Promise<any> {
  if(occPromise) return occPromise;
  occPromise = (async ()=>{
    // CDNのESMを動的import（Viteにバンドルさせない）。wasmはlocateFileでCDNを指す。
    const mod = await import(/* @vite-ignore */ OCC_BASE + 'opencascade.full.js');
    const factory = mod.default;
    return await new factory({ locateFile: (p: string)=> p.endsWith('.wasm') ? OCC_BASE + 'opencascade.full.wasm' : p });
  })();
  return occPromise;
}
async function loadStep(buf: ArrayBuffer){
  showBusy('CADエンジン準備中（初回のみwasm取得 ~13MB）…');
  const oc = await loadOCC();
  showBusy('STEP解析中（色付き・曲面メッシュ化）…');
  await nextFrame();
  oc.FS.writeFile('/in.step', new Uint8Array(buf));
  // XCAFドキュメントへ色・名前付きで読み込む
  const app = oc.XCAFApp_Application.GetApplication().get();
  const doc = new oc.Handle_TDocStd_Document_1();
  app.NewDocument_2(new oc.TCollection_ExtendedString_2('MDTV-XCAF', true), doc);
  const reader = new oc.STEPCAFControl_Reader_1();
  reader.SetColorMode(true); reader.SetNameMode(true); reader.SetLayerMode(true);
  if(reader.ReadFile('/in.step') !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP解析に失敗');
  reader.Transfer_1(doc, new oc.Message_ProgressRange_1());
  // glTF出力には三角形分割が要る。葉(部品)シェイプをすべてメッシュ化。
  const main = doc.get().Main();
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(main).get();
  const labels = new oc.TDF_LabelSequence_1();
  shapeTool.GetShapes(labels);
  for(let i=1;i<=labels.Length();i++){
    const lab = labels.Value(i);
    if(!oc.XCAFDoc_ShapeTool.IsSimpleShape(lab)) continue;
    const shape = new oc.TopoDS_Shape();
    if(!oc.XCAFDoc_ShapeTool.GetShape_1(lab, shape)) continue;
    new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
    shape.delete();
  }
  // 色付き glb をメモリに書き出す。単位はmm維持(入出力単位を0.001で揃える)。
  const writer = new oc.RWGltf_CafWriter(new oc.TCollection_AsciiString_2('/out.glb'), true);
  const conv = new oc.RWMesh_CoordinateSystemConverter();
  conv.SetInputLengthUnit(0.001); conv.SetOutputLengthUnit(0.001);
  writer.SetCoordinateSystemConverter(conv);
  writer.Perform_2(doc, new oc.TColStd_IndexedDataMapOfStringString_1(), new oc.Message_ProgressRange_1());
  const glb = oc.FS.readFile('/out.glb'); // Uint8Array
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  // OCCTのwasmヒープを片付ける（大きいSTEPの連続読込でのリークを抑える）
  reader.delete(); writer.delete(); conv.delete(); labels.delete();
  oc.FS.unlink('/in.step'); oc.FS.unlink('/out.glb');
  const gltf = await new GLTFLoader().parseAsync(ab, '');
  const g = mergeColored(gltf.scene);
  if(!g) throw new Error('STEPからメッシュを取得できませんでした');
  return g;
}

// ---------- サムネイル生成（モデル一覧の小プレビュー） ----------
// 専用のオフスクリーンレンダラに対象だけを置いてISO方向から1枚撮り、PNGのdataURLにする。
const THUMB_SIZE = 104;
let thumbRenderer: THREE.WebGLRenderer | null = null, thumbScene: THREE.Scene | null = null, thumbCam: THREE.PerspectiveCamera | null = null;
function ensureThumbRenderer(){
  if(thumbRenderer) return;
  thumbRenderer = new THREE.WebGLRenderer({ antialias:true, alpha:true, preserveDrawingBuffer:true });
  thumbRenderer.setPixelRatio(1);
  thumbRenderer.setSize(THUMB_SIZE, THUMB_SIZE);
  thumbScene = new THREE.Scene();
  thumbScene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const d1 = new THREE.DirectionalLight(0xffffff, 0.9); d1.position.set(1,1.4,0.8); thumbScene.add(d1);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.4); d2.position.set(-1,-0.6,-0.8); thumbScene.add(d2);
  thumbCam = new THREE.PerspectiveCamera(45, 1, 0.01, 1e6); thumbCam.up.set(0,0,1);
}
function renderThumb(obj: THREE.Object3D, box: THREE.Box3){
  ensureThumbRenderer();
  thumbScene!.add(obj);
  const c = new THREE.Vector3(); box.getCenter(c);
  const r = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const d = r / Math.tan(THREE.MathUtils.degToRad(thumbCam!.fov/2)) * 1.4;
  const v = new THREE.Vector3(1,-1,0.8).normalize();
  thumbCam!.position.copy(c).add(v.multiplyScalar(d)); thumbCam!.lookAt(c); thumbCam!.updateProjectionMatrix();
  thumbRenderer!.render(thumbScene!, thumbCam!);
  const url = thumbRenderer!.domElement.toDataURL('image/png');
  thumbScene!.remove(obj);
  return url;
}
function makeThumbnail(m: Model){
  try {
    if(m.isGcode){
      const grp = new THREE.Group();
      for(const lo of m.lineObjs!){
        grp.add(new THREE.LineSegments(lo.obj.geometry, new THREE.LineBasicMaterial({ color:lo.color })));
      }
      const box = new THREE.Box3(
        new THREE.Vector3(-m.size.x/2,-m.size.y/2,0), new THREE.Vector3(m.size.x/2,m.size.y/2,m.size.z));
      const url = renderThumb(grp, box);
      grp.children.forEach(ch=> ((ch as THREE.LineSegments).material as THREE.Material).dispose());
      return url;
    }
    const hasVColor = !!m.geometry.attributes.color;
    const mat = new THREE.MeshStandardMaterial({ color:hasVColor?0xffffff:m.color, vertexColors:hasVColor, metalness:0.05, roughness:0.65, side:THREE.DoubleSide });
    const mesh = new THREE.Mesh(m.geometry, mat);
    const url = renderThumb(mesh, m.geometry.boundingBox!);
    mat.dispose();
    return url;
  } catch(e){ console.warn('サムネイル生成に失敗', e); return null; }
}

// ---------- モデル追加 ----------
function insertModel(m: Model, previous?: PreviousState | null){
  if(Number.isInteger(previous?.index) && previous!.index >= 0) models.splice(Math.min(previous!.index, models.length), 0, m);
  else models.push(m);
}
function addModel(name: string, geometry: THREE.BufferGeometry, options: LoadOptions = {}){
  if(!geometry.attributes.normal) geometry.computeVertexNormals();
  geometry.computeBoundingBox();

  // 原点中心(XY)・底面z=0へ正規化（整列は relayout で行う）
  const bb0 = geometry.boundingBox!;
  const c = new THREE.Vector3(); bb0.getCenter(c);
  geometry.translate(-c.x, -c.y, -bb0.min.z);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const size = new THREE.Vector3(); geometry.boundingBox!.getSize(size);

  const color = options.previous?.color ?? PALETTE[colorCursor++ % PALETTE.length];
  // STEP等で頂点カラーを持つ場合はそれを忠実表示（base色を白にして頂点色を乗算で素通し）。
  const hasVColor = !!geometry.attributes.color;
  const mat = new THREE.MeshStandardMaterial({
    color: hasVColor ? 0xffffff : color, vertexColors: hasVColor,
    metalness:0.05, roughness:0.65, side:THREE.DoubleSide, clippingPlanes:[]
  });

  const mesh = new THREE.Mesh(geometry, mat);
  const box = new THREE.Box3Helper(geometry.boundingBox!.clone(), 0xffb347);
  const backface = new THREE.Mesh(geometry, backfaceRed);
  const selectionBox = new THREE.Box3Helper(geometry.boundingBox!.clone(), 0x4f9cff); selectionBox.visible=false;
  const label = createModelLabel(name, size, color);

  const group = new THREE.Group();
  group.add(mesh, box, backface, selectionBox, label);
  scene.add(group);

  const tri = geometry.index ? geometry.index.count/3 : geometry.attributes.position.count/3;
  const m: Model = {
    id:options.previous?.id ?? ++modelIdCursor,
    name, group, mesh, wire:null, edges:null, box, backface, selectionBox, label, geometry, mat, color, visible:true,
    size, tri:Math.round(tri), vert:geometry.attributes.position.count, vol:signedVolume(geometry),
    sourceKey:options.sourceKey, sourceUrl:options.sourceUrl,
  };
  if(options.previous) m.visible = options.previous.visible;
  m.thumb = makeThumbnail(m);
  insertModel(m, options.previous);
  if(options.previous?.selected) setSelectedModel(m.id); else updateModelDecorations();

  document.getElementById('hint')!.style.display = 'none';
  renderList();
  relayout();
  applyDisplay();
  if(models.length === 1) fitView();
}

// ワイヤー/エッジは重いので必要時のみ生成。巨大メッシュは安全のためスキップ。
const WIRE_TRI_LIMIT = 1_500_000;   // これ超でワイヤー生成を抑止（Set上限・メモリ対策）
function ensureWire(m: Model){
  if(m.wire !== null) return true;
  if(m.tri > WIRE_TRI_LIMIT){ m.wire = false; return false; }
  m.wire = new THREE.LineSegments(new THREE.WireframeGeometry(m.geometry),
      new THREE.LineBasicMaterial({ color:0xffffff, transparent:true, opacity:0.25 }));
  m.group.add(m.wire); return true;
}
function ensureEdges(m: Model){
  if(m.edges !== null) return true;
  if(m.tri > WIRE_TRI_LIMIT){ m.edges = false; return false; }
  m.edges = new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 30),
      new THREE.LineBasicMaterial({ color:0x000000 }));
  m.group.add(m.edges); return true;
}

function removeModel(m: Model){
  const i = models.indexOf(m); if(i<0) return;
  scene.remove(m.group);
  disposeModelDecorations(m);
  m.geometry.dispose();
  if(m.isGcode){
    for(const lo of m.lineObjs!){ lo.obj.geometry.dispose(); lo.mat.dispose(); }
    if(m.travelObj){ m.travelObj.geometry.dispose(); (m.travelObj.material as THREE.Material).dispose(); }
    if(activeGcode === m){
      gcPlaying = false; updatePlayBtn();
      if(vanishObj){ scene.remove(vanishObj); vanishObj.geometry.dispose(); (vanishObj.material as THREE.Material).dispose(); vanishObj=null; }
      activeGcode = models.find(x=> x.isGcode && x!==m) || null;
      if(activeGcode){ buildGcodePanel(activeGcode); applyGcMode(); } else gcodeGroup.style.display = 'none';
    }
    gcSyncRowUpdate();
  } else {
    m.mat!.dispose();
    if(m.wire){ m.wire.geometry.dispose(); (m.wire.material as THREE.Material).dispose(); }
    if(m.edges){ m.edges.geometry.dispose(); (m.edges.material as THREE.Material).dispose(); }
  }
  models.splice(i,1);
  if(m.id===selectedModelId) setSelectedModel(null);
  renderList(); relayout(); applyDisplay();
  if(models.length === 0){ document.getElementById('hint')!.style.display = ''; }
}

function signedVolume(geometry: THREE.BufferGeometry){
  const p = geometry.attributes.position, idx = geometry.index;
  let vol = 0;
  const a=new THREE.Vector3(), b=new THREE.Vector3(), cc=new THREE.Vector3();
  const n = idx ? idx.count : p.count;
  for(let i=0;i<n;i+=3){
    const ia = idx? idx.getX(i):i, ib = idx? idx.getX(i+1):i+1, ic = idx? idx.getX(i+2):i+2;
    a.fromBufferAttribute(p,ia); b.fromBufferAttribute(p,ib); cc.fromBufferAttribute(p,ic);
    vol += a.dot(b.clone().cross(cc))/6;
  }
  return Math.abs(vol);
}

// ========== Bambu/Orca の .3mf からスライス結果(gcode)を取り出す ==========
// Bambu の .gcode.3mf はメッシュを含まないことがある（3dmodel.model が空）。
// その場合は内蔵 gcode を取り出してツールパス表示する。メッシュ入りなら null を返して
// 従来のメッシュ表示へフォールバックさせる。
function extractGcodeFrom3mf(buf: ArrayBuffer){
  let files: Record<string, Uint8Array>;
  try { files = (fflate as any).unzipSync(new Uint8Array(buf)); } catch(e){ return null; }
  // Metadata/plate_*.gcode（.md5 は除外）を探す
  const gkey = Object.keys(files).find(k=> /\.gcode$/i.test(k) && !/\.md5$/i.test(k));
  if(!gkey) return null;
  const text = new TextDecoder().decode(files[gkey]);
  // slice_info.config / plate_*.json から統計と警告を組み立てる（result.json 互換の形へ）
  let rj: ResultJson | null = null, objName: string | null = null;
  const sKey = Object.keys(files).find(k=> /slice_info\.config$/i.test(k));
  const get = (xml: string, key: string)=>{ const m = xml.match(new RegExp(`key="${key}"\\s+value="([^"]*)"`)); return m? m[1]:null; };
  let weight: string | null = null;
  if(sKey){
    const xml = new TextDecoder().decode(files[sKey]);
    const pred = get(xml,'prediction'); weight = get(xml,'weight');
    const warns = [...xml.matchAll(/<warning msg="([^"]*)"[^>]*level="(\d+)"/g)].map(w=>`${w[1]} (lv${w[2]})`);
    const om = xml.match(/<object[^>]*name="([^"]*)"/); if(om) objName = om[1];
    rj = { sliced_plates:[{
      total_predication: pred? parseFloat(pred): undefined,
      warning_message: warns.join(' / '),
    }] };
    const jKey = Object.keys(files).find(k=> /plate_\d+\.json$/i.test(k));
    if(jKey){ try {
      const j = JSON.parse(new TextDecoder().decode(files[jKey]));
      const lh = j.bbox_objects?.[0]?.layer_height; if(lh) rj.layer_height = lh;
    } catch(e){} }
  }
  return { text, resultJson: rj, objName, weight: weight? parseFloat(weight): null };
}

// ========== G-code パース＆描画 ==========
// Bambu/Orca の gcode は相対押し出し(M83)。E>0 のG0/G1移動を押し出しセグメントとして扱い、
// `; FEATURE:` で種別、`; CHANGE_LAYER`/`; Z_HEIGHT:` でレイヤーを追う。
function parseGcode(text: string): ParsedGcode {
  const lines = text.split('\n');
  const header: GcodeHeader = {};
  for(const l of lines){
    if(l[0] !== ';') continue;
    let m: RegExpMatchArray | null;
    if((m = l.match(/model printing time:\s*([^;]+)/))) header.printTime = m[1].trim();
    else if((m = l.match(/total filament length \[mm\]\s*:\s*([\d.]+)/))) header.filLen = parseFloat(m[1]);
    else if((m = l.match(/total filament weight \[g\]\s*:\s*([\d.]+)/))) header.filWeight = parseFloat(m[1]);
    else if((m = l.match(/total layer number:\s*(\d+)/))) header.layerNum = parseInt(m[1]);
    if(l.startsWith('; CONFIG_BLOCK_START')) break;
  }

  let x=0, y=0, z=0, hasPos=false, feed=0;
  let layer = -1, feature = 'Custom';
  const feats = new Map<string, FeatureData>();   // name -> { segs, layers, feed, ev, len }
  const travel: { segs: number[]; layers: number[] } = { segs:[], layers:[] };
  let zMin=Infinity, zMax=-Infinity, xMin=Infinity, xMax=-Infinity, yMin=Infinity, yMax=-Infinity;

  const featOf = (name: string)=>{ let f = feats.get(name); if(!f){ f={segs:[],layers:[],feed:[],ev:[],len:[]}; feats.set(name,f); } return f; };

  for(let li=0; li<lines.length; li++){
    const line = lines[li];
    if(line[0] === ';'){
      let m: RegExpMatchArray | null;
      if((m = line.match(/^;\s*FEATURE:\s*(.+?)\s*$/))) feature = m[1];
      else if(/^;\s*CHANGE_LAYER/.test(line)) layer++;
      else if((m = line.match(/^;\s*Z_HEIGHT:\s*([\d.]+)/))) z = parseFloat(m[1]);
      continue;
    }
    if(line[0] !== 'G') continue;
    const cmd = line.slice(0,3);
    if(cmd !== 'G1 ' && cmd !== 'G0 ' && cmd !== 'G1' && cmd !== 'G0') continue;
    let nx=x, ny=y, nz=z, e=0, moved=false;
    // トークン抽出
    const parts = line.split(' ');
    for(let p=1;p<parts.length;p++){
      const tok = parts[p]; if(!tok) continue;
      const c = tok[0], v = parseFloat(tok.slice(1));
      if(c==='X'){ nx=v; moved=true; } else if(c==='Y'){ ny=v; moved=true; }
      else if(c==='Z'){ nz=v; } else if(c==='E'){ e=v; } else if(c==='F'){ feed=v; }
      else if(c===';') break;
    }
    if(nz!==z) z = nz;
    if(moved && hasPos){
      const lyr = layer < 0 ? 0 : layer;
      if(e > 0){
        const f = featOf(feature);
        const dx=nx-x, dy=ny-y, dz=nz-z;
        f.segs.push(x,y,z, nx,ny,nz); f.layers.push(lyr);
        f.feed.push(feed); f.ev.push(e); f.len.push(Math.hypot(dx,dy,dz));
        // スカート/ブリムは造形外周なので中心合わせ用bboxから除外（STLオーバーレイを揃える）
        if(feature !== 'Skirt' && feature !== 'Brim'){
          if(z<zMin)zMin=z; if(z>zMax)zMax=z;
          if(x<xMin)xMin=x; if(x>xMax)xMax=x; if(y<yMin)yMin=y; if(y>yMax)yMax=y;
          if(nx<xMin)xMin=nx; if(nx>xMax)xMax=nx; if(ny<yMin)yMin=ny; if(ny>yMax)yMax=ny;
        }
      } else {
        travel.segs.push(x,y,z, nx,ny,nz); travel.layers.push(lyr);
      }
    }
    x=nx; y=ny; z=nz; hasPos=true;
  }
  const nLayers = Math.max(layer+1, 1);
  if(!isFinite(zMin)){ zMin=0; zMax=0; xMin=0; xMax=0; yMin=0; yMax=0; }
  return { feats, travel, nLayers, header,
    bbox: { min:[xMin,yMin,zMin], max:[xMax,yMax,zMax] } };
}

// 各フィーチャの「レイヤーごとの累積頂点数」を作る（drawRangeでレイヤー表示用）
function layerPrefix(layers: number[], nLayers: number){
  const per = new Uint32Array(nLayers+1);
  for(const lyr of layers){ per[Math.min(lyr,nLayers-1)+1] += 2; }  // 1セグ=2頂点
  for(let i=1;i<per.length;i++) per[i] += per[i-1];
  return per;
}

function addGcode(name: string, parsed: ParsedGcode, resultJson: ResultJson | null, options: LoadOptions = {}){
  const { feats, travel, nLayers, header, bbox } = parsed;
  // STL と同じ正規化（XY中心・底面z=0）でオーバーレイが揃う
  const cx = (bbox.min[0]+bbox.max[0])/2, cy = (bbox.min[1]+bbox.max[1])/2, mz = bbox.min[2];
  const size = new THREE.Vector3(bbox.max[0]-bbox.min[0], bbox.max[1]-bbox.min[1], bbox.max[2]-bbox.min[2]);

  const group = new THREE.Group();
  const lineObjs: LineObj[] = [];
  const center = (arr: Float32Array)=>{ for(let i=0;i<arr.length;i+=3){ arr[i]-=cx; arr[i+1]-=cy; arr[i+2]-=mz; } return arr; };

  // フィーチャを押し出し総長の多い順に（凡例の並びを安定化）
  const names = [...feats.keys()].sort((a,b)=> feats.get(b)!.segs.length - feats.get(a)!.segs.length);
  for(const fname of names){
    const f = feats.get(fname)!;
    if(!f.segs.length) continue;
    const pos = center(Float32Array.from(f.segs));
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.length), 3));  // 色分けモード用
    const col = featureColor(fname);
    const mat = new THREE.LineBasicMaterial({ color: col });
    const obj = new THREE.LineSegments(g, mat);
    obj.frustumCulled = false;
    group.add(obj);
    lineObjs.push({ feature:fname, obj, mat, color:col, prefix:layerPrefix(f.layers, nLayers),
      nSeg:f.layers.length, layers:f.layers, feed:f.feed, ev:f.ev, len:f.len, pos });
  }
  // トラベル線（既定は非表示）
  let travelObj = null;
  if(travel.segs.length){
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(center(Float32Array.from(travel.segs)),3));
    const mat = new THREE.LineBasicMaterial({ color:0x55606e, transparent:true, opacity:0.5 });
    travelObj = new THREE.LineSegments(g, mat); travelObj.frustumCulled = false; travelObj.visible = false;
    group.add(travelObj);
    travelObj.userData.prefix = layerPrefix(travel.layers, nLayers);
  }

  scene.add(group);
  // overallBox 等が参照する boundingBox を持つ空ジオメトリ
  const geometry = new THREE.BufferGeometry();
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-size.x/2,-size.y/2,0), new THREE.Vector3(size.x/2,size.y/2,size.z));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  const selectionBox = new THREE.Box3Helper(geometry.boundingBox.clone(), 0x4f9cff); selectionBox.visible=false;
  const label = createModelLabel(name, size, lineObjs[0]?.color ?? 0xbfc4cc);
  group.add(selectionBox, label);

  const m: Model = {
    id:options.previous?.id ?? ++modelIdCursor,
    name, group, geometry, isGcode:true, visible:true, size, selectionBox, label,
    color: lineObjs[0]?.color ?? 0xbfc4cc, lineObjs, travelObj, nLayers,
    curLayer: Math.min(options.previous?.curLayer ?? nLayers-1, nLayers-1),
    featVisible:new Map(names.map(n=>[n, options.previous?.featVisible?.get(n) ?? true])),
    header, resultJson, tri:0, vert:0, vol:0,
    sourceKey:options.sourceKey, sourceUrl:options.sourceUrl,
  };
  if(options.previous) m.visible = options.previous.visible;
  m.thumb = makeThumbnail(m);
  insertModel(m, options.previous);
  if(options.previous?.selected) setSelectedModel(m.id); else updateModelDecorations();
  activeGcode = m;
  document.getElementById('hint')!.style.display = 'none';
  renderList(); relayout(); applyDisplay();
  buildGcodePanel(m);
  applyGcMode(); gcSyncRowUpdate();
  if(models.length === 1) fitView();
}

// ---------- G-code パネル ----------
let activeGcode: Model | null = null;
const gcodeGroup = document.getElementById('gcodeGroup')!;
const gcLayer = document.getElementById('gcLayer') as HTMLInputElement;
const gcLayerLabel = document.getElementById('gcLayerLabel')!;

function fmtSec(s: number){ s=Math.round(s); const h=Math.floor(s/3600), m=Math.floor(s%3600/60), sec=s%60;
  return (h?h+'h ':'')+(h||m?m+'m ':'')+sec+'s'; }

function buildGcodePanel(m: Model){
  gcodeGroup.style.display = '';
  document.getElementById('gcName')!.textContent = m.name;
  gcLayer.max = String(m.nLayers!-1); gcLayer.value = String(m.curLayer);
  document.getElementById('gcVanishRow')!.style.display = '';
  updateGcLayerLabel(m);
  // 凡例
  const leg = document.getElementById('gcLegend')!; leg.innerHTML = '';
  const times = m.resultJson?.sliced_plates?.[0]?.feature_type_times || {};
  for(const lo of m.lineObjs!){
    const row = document.createElement('div'); row.className = 'leg';
    const hex = '#'+lo.color.toString(16).padStart(6,'0');
    const t = times[lo.feature];
    row.innerHTML = `<div class="sw" style="background:${hex}"></div><span>${lo.feature}</span>`+
      (t? `<span class="t">${fmtSec(t)}</span>`:'');
    row.onclick = ()=>{
      const v = !m.featVisible!.get(lo.feature);
      m.featVisible!.set(lo.feature, v); row.classList.toggle('off', !v); applyDisplay();
    };
    leg.appendChild(row);
  }
  // 統計
  buildGcodeStats(m);
}

function buildGcodeStats(m: Model){
  const el = document.getElementById('gcStats')!;
  const h = m.header || {}, rj = m.resultJson;
  const rows = [];
  if(h.printTime) rows.push(`予測印刷時間 <b>${h.printTime}</b>`);
  else if(rj?.sliced_plates?.[0]?.total_predication) rows.push(`予測印刷時間 <b>${fmtSec(rj.sliced_plates[0].total_predication)}</b>`);
  if(h.filLen) rows.push(`フィラメント長 <b>${(h.filLen/1000).toFixed(2)}</b> m`);
  if(h.filWeight) rows.push(`フィラメント重量 <b>${h.filWeight.toFixed(1)}</b> g`);
  rows.push(`レイヤー数 <b>${m.nLayers}</b>`);
  if(rj){
    const sp = rj.sliced_plates?.[0];
    const lhParts = [];
    if(rj.layer_height) lhParts.push(`層厚 <b>${rj.layer_height.toFixed(2)}</b> mm`);
    if(rj.wall_loops != null) lhParts.push(`壁 <b>${rj.wall_loops}</b>`);
    if(rj.sparse_infill_density != null) lhParts.push(`infill <b>${rj.sparse_infill_density}%</b>`);
    if(lhParts.length) rows.push(lhParts.join('　'));
    const warn = sp?.warning_message;
    if(warn && warn.trim()) rows.push(`<span class="warn">⚠ ${warn}</span>`);
  }
  let html = rows.map(r=>`<div>${r}</div>`).join('');
  // フィーチャ別時間バー
  const times = rj?.sliced_plates?.[0]?.feature_type_times;
  if(times){
    const entries = Object.entries(times).filter(([k,v])=>v>0 && k!=='Travel' && k!=='Undefined').sort((a,b)=>b[1]-a[1]);
    const tot = entries.reduce((s,[,v])=>s+v,0) || 1;
    html += `<div style="margin-top:8px;font-size:10px;color:var(--muted)">フィーチャ別 時間配分</div>`;
    for(const [k,v] of entries){
      const col = '#'+featureColor(k).toString(16).padStart(6,'0');
      html += `<div style="display:flex;align-items:center;gap:6px"><span style="flex:1">${k}</span><b>${(v/tot*100).toFixed(0)}%</b></div>`+
        `<div class="bar" style="width:${(v/tot*100).toFixed(1)}%;background:${col}"></div>`;
    }
  }
  el.innerHTML = html;
}

function updateGcLayerLabel(m: Model){
  const z = (m.size.z * (m.nLayers? (m.curLayer!+1)/m.nLayers : 1));
  gcLayerLabel.textContent = `${m.curLayer!+1} / ${m.nLayers}　(z≈${z.toFixed(1)}mm)`;
}
function applyGcodeLayer(m: Model){
  for(const lo of m.lineObjs!) lo.obj.geometry.setDrawRange(0, lo.prefix[m.curLayer!+1]);
  if(m.travelObj) m.travelObj.geometry.setDrawRange(0, m.travelObj.userData.prefix[m.curLayer!+1]);
}
let gcShowTravel = false, gcGhost = false, gcMode = 'feature', gcSync = false;
let gcPlaying = false, gcSpeed = 60, gcPlayAccum = 0;

const gcodeModels = ()=> models.filter(x=> x.isGcode);
function gcSyncRowUpdate(){ document.getElementById('gcSyncRow')!.style.display = gcodeModels().length>1 ? '' : 'none'; }

// レイヤー設定（同期ON時は全gcodeへ）
function setLayer(L: number){
  const apply = (m: Model)=>{ m.curLayer = Math.max(0, Math.min(L, m.nLayers!-1)); applyGcodeLayer(m);
    if(m===activeGcode) updateGcLayerLabel(m); if(gcVanish) updateVanish(m); };
  if(gcSync) gcodeModels().forEach(apply); else if(activeGcode) apply(activeGcode);
}
gcLayer.addEventListener('input', ()=>{ if(!activeGcode) return; gcPlaying=false; updatePlayBtn(); setLayer(parseInt(gcLayer.value)); });
document.getElementById('gcTravel')!.addEventListener('change', e=>{ gcShowTravel = (e.target as HTMLInputElement).checked; applyDisplay(); });
document.getElementById('gcGhost')!.addEventListener('change', e=>{ gcGhost = (e.target as HTMLInputElement).checked; applyDisplay(); });

// ---- 再生（ビルドアップ） ----
const gcPlayBtn = document.getElementById('gcPlay')!;
function updatePlayBtn(){ gcPlayBtn.textContent = gcPlaying ? '⏸ 停止' : '▶ 再生'; }
gcPlayBtn.onclick = ()=>{
  if(!activeGcode) return;
  if(!gcPlaying && activeGcode.curLayer! >= activeGcode.nLayers!-1) setLayer(0);  // 末尾なら頭出し
  gcPlaying = !gcPlaying; gcPlayAccum = 0; updatePlayBtn();
};
document.getElementById('gcSpeed')!.onchange = e=> gcSpeed = parseInt((e.target as HTMLSelectElement).value);
document.getElementById('gcSync')!.onchange = e=>{ gcSync = (e.target as HTMLInputElement).checked; if(gcSync && activeGcode) setLayer(activeGcode.curLayer!); };
// animate ループから毎フレーム呼ぶ
function tickPlayback(dt: number){
  if(!gcPlaying || !activeGcode) return;
  gcPlayAccum += dt * gcSpeed;
  if(gcPlayAccum < 1) return;
  const step = Math.floor(gcPlayAccum); gcPlayAccum -= step;
  let L = activeGcode.curLayer! + step;
  if(L >= activeGcode.nLayers!-1){ L = activeGcode.nLayers!-1; gcPlaying = false; updatePlayBtn(); }
  gcLayer.value = String(L); setLayer(L);
}

// ---- 色分けモード ----
const gcModeNote = document.getElementById('gcModeNote')!;
document.getElementById('gcMode')!.onchange = e=>{ gcMode = (e.target as HTMLSelectElement).value; applyGcMode(); };
document.getElementById('gcFlowMax')!.onchange = ()=>{ if(gcMode==='flow') applyGcMode(); };
function applyGcMode(){
  document.getElementById('gcFlowRow')!.style.display = gcMode==='flow' ? '' : 'none';
  for(const m of gcodeModels()){
    if(gcMode==='feature'){ for(const lo of m.lineObjs!){ lo.mat.vertexColors=false; lo.mat.color.set(lo.color); lo.mat.needsUpdate=true; } }
    else if(gcMode==='overhang'){ computeOverhangColors(m); for(const lo of m.lineObjs!){ lo.mat.vertexColors=true; lo.mat.color.set(0xffffff); lo.mat.needsUpdate=true; } }
    else if(gcMode==='flow'){ computeFlowColors(m, parseFloat((document.getElementById('gcFlowMax') as HTMLInputElement).value)||12); for(const lo of m.lineObjs!){ lo.mat.vertexColors=true; lo.mat.color.set(0xffffff); lo.mat.needsUpdate=true; } }
  }
  gcModeNote.innerHTML =
    gcMode==='overhang' ? '<span style="color:#ff5b50">赤=真下に支えなし</span>（サポート要/TPU垂れ懸念）　灰=支持あり' :
    gcMode==='flow' ? '青→緑→黄→<span style="color:#ff5b50">赤(=上限超)</span>。上限はTPU等の最大体積流量を入れる' : '';
}

// 真下(直下レイヤー)に材料があるか＝支持判定 → オーバーハング色分け
function computeOverhangColors(m: Model){
  if(m._overhangDone) return;
  const CELL = 0.8;  // 占有グリッド分解能(mm)
  // 各レイヤーの占有セル集合（全フィーチャの押し出し中点）
  const occ = Array.from({length:m.nLayers!}, ()=> new Set<string>());
  for(const lo of m.lineObjs!){
    const p = lo.pos, L = lo.layers;
    for(let i=0;i<L.length;i++){
      const b=6*i; const mx=(p[b]+p[b+3])/2, my=(p[b+1]+p[b+4])/2;
      occ[L[i]].add(Math.round(mx/CELL)+','+Math.round(my/CELL));
    }
  }
  const RED=[1,0.36,0.32], GRY=[0.32,0.34,0.38];
  for(const lo of m.lineObjs!){
    const p=lo.pos, L=lo.layers, col=lo.obj.geometry.attributes.color.array;
    for(let i=0;i<L.length;i++){
      const lyr=L[i]; let supported = (lyr===0);
      if(!supported){
        const b=6*i; const mx=(p[b]+p[b+3])/2, my=(p[b+1]+p[b+4])/2;
        const gx=Math.round(mx/CELL), gy=Math.round(my/CELL), below=occ[lyr-1];
        for(let ox=-1;ox<=1&&!supported;ox++) for(let oy=-1;oy<=1;oy++) if(below.has((gx+ox)+','+(gy+oy))){ supported=true; break; }
      }
      const c = supported?GRY:RED, b6=6*i;
      col[b6]=c[0];col[b6+1]=c[1];col[b6+2]=c[2]; col[b6+3]=c[0];col[b6+4]=c[1];col[b6+5]=c[2];
    }
    lo.obj.geometry.attributes.color.needsUpdate = true;
  }
  m._overhangDone = true;
}

// 体積流量 mm³/s = E長 × フィラメント断面積 × 速度 / セグメント長
const FIL_AREA = Math.PI*Math.pow(1.75/2,2);
function flowRamp(t: number){ // 0..1 → 青→緑→黄→赤
  t=Math.max(0,Math.min(1,t));
  if(t<0.33){ const k=t/0.33; return [0.2*(1-k),0.5+0.5*k,1-0.5*k]; }
  if(t<0.66){ const k=(t-0.33)/0.33; return [k,1,0.5*(1-k)]; }
  const k=(t-0.66)/0.34; return [1,1-0.6*k,0];
}
function computeFlowColors(m: Model, maxFlow: number){
  let peak=0;
  for(const lo of m.lineObjs!){
    const col=lo.obj.geometry.attributes.color.array, n=lo.len.length;
    for(let i=0;i<n;i++){
      const len=lo.len[i]; let flow=0;
      if(len>1e-4 && lo.feed[i]>0) flow = lo.ev[i]*FIL_AREA*(lo.feed[i]/60)/len;
      if(flow>peak) peak=flow;
      const c = flow>=maxFlow ? [1,0,0.15] : flowRamp(flow/maxFlow);
      const b=6*i; col[b]=c[0];col[b+1]=c[1];col[b+2]=c[2]; col[b+3]=c[0];col[b+4]=c[1];col[b+5]=c[2];
    }
    lo.obj.geometry.attributes.color.needsUpdate = true;
  }
  m._flowPeak = peak;
  gcModeNote.innerHTML = `青→緑→黄→<span style="color:#ff5b50">赤(=上限超)</span>　実測ピーク <b style="color:var(--fg)">${peak.toFixed(1)}</b> mm³/s`;
}

// ---- 消えた壁の検出（現レイヤーで STL に肉があるが押し出しが無いセル） ----
let gcVanish = false;
let vanishObj: THREE.Points | null = null;
document.getElementById('gcVanish')!.addEventListener('change', e=>{
  gcVanish = (e.target as HTMLInputElement).checked;
  if(vanishObj){ scene.remove(vanishObj); vanishObj.geometry.dispose(); (vanishObj.material as THREE.Material).dispose(); vanishObj=null; }
  if(gcVanish && activeGcode) updateVanish(activeGcode);
});
function meshAt(){ return models.find(x=> !x.isGcode && x.visible); }
function updateVanish(m: Model){
  if(!gcVanish) return;
  if(vanishObj){ scene.remove(vanishObj); vanishObj.geometry.dispose(); (vanishObj.material as THREE.Material).dispose(); vanishObj=null; }
  const meshM = meshAt();
  if(!meshM){ gcModeNote.innerHTML = '<span class="warn">消えた壁検出にはSTL等のメッシュを読み込んでください</span>'; return; }
  const CELL = 0.6, z = m.size.z * (m.curLayer!+0.5)/m.nLayers!;  // 現レイヤー中央高さ
  // gcode占有（現レイヤー）
  const occ = new Set<string>();
  for(const lo of m.lineObjs!){ const p=lo.pos,L=lo.layers; for(let i=0;i<L.length;i++) if(L[i]===m.curLayer){ const b=6*i; occ.add(Math.round((p[b]+p[b+3])/2/CELL)+','+Math.round((p[b+1]+p[b+4])/2/CELL)); } }
  // メッシュ占有：z平面でXYグリッドを内外判定（鉛直レイで交差回数）
  const pts = vanishSolidCells(meshM, z, CELL, m.group.position);
  const verts = [];
  for(const [gx,gy] of pts){
    const key = gx+','+gy;
    let near=false; for(let ox=-1;ox<=1&&!near;ox++)for(let oy=-1;oy<=1;oy++) if(occ.has((gx+ox)+','+(gy+oy))){near=true;break;}
    if(!near) verts.push(gx*CELL, gy*CELL, z);  // gcode座標系(=活性gcodeのgroupローカル)
  }
  if(verts.length){
    const g=new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(verts,3));
    vanishObj = new THREE.Points(g, new THREE.PointsMaterial({ color:0xff2bd0, size:CELL*1.6, sizeAttenuation:true }));
    vanishObj.position.copy(m.group.position);  // 活性gcodeと同じ配置
    scene.add(vanishObj);
  }
  gcModeNote.innerHTML = verts.length
    ? `<span style="color:#ff2bd0">消えた壁候補 ${verts.length} 箇所</span>（z≈${z.toFixed(1)}mm・桃点）`
    : `この層では消えた壁なし（z≈${z.toFixed(1)}mm）`;
}
// メッシュをz平面でサンプリングし、ソリッド内部のXYセル(gcodeローカル座標)を返す
const _ray = new THREE.Raycaster(); (_ray as any).firstHitOnly=false;
function vanishSolidCells(meshM: Model, zLocal: number, CELL: number, gcPos: THREE.Vector3){
  const out: number[][] = [];
  const bb = meshM.geometry.boundingBox!;  // メッシュローカル(=group原点中心)
  // メッシュのgroup位置を考慮してワールド→比較は活性gcodeローカルで行う。簡略化のため
  // 両者とも各groupローカルで原点中心・底面z=0に正規化済みなので、同じ造形物なら座標一致。
  const meshObj = meshM.mesh!;
  const dir = new THREE.Vector3(0,0,1);
  const origin = new THREE.Vector3();
  const minx=bb.min.x, maxx=bb.max.x, miny=bb.min.y, maxy=bb.max.y;
  for(let gx=Math.floor(minx/CELL); gx<=Math.ceil(maxx/CELL); gx++){
    for(let gy=Math.floor(miny/CELL); gy<=Math.ceil(maxy/CELL); gy++){
      const wx=gx*CELL + gcPos.x, wy=gy*CELL + gcPos.y;
      origin.set(wx, wy, -1000); dir.set(0,0,1);
      _ray.set(origin, dir);
      const hits = _ray.intersectObject(meshObj, false);
      // zLocal をワールドzへ：meshグループ位置 + zLocal
      const zw = zLocal + meshM.group.position.z;
      let inside=0; for(const h of hits){ if(h.point.z <= zw) inside++; }
      if(inside%2===1) out.push([gx,gy]);
    }
  }
  return out;
}

// ---------- 配置（重ね / 横並べ / グリッド）----------
function relayout(){
  clearMeasure();
  if(!models.length){
    rebuildGrid(80); setupClipRange();
    return;
  }
  const align = (document.getElementById('alignSel') as HTMLSelectElement).value;
  const mz = maxZ();
  // center整列: 各モデルのz中心を全体の中段に揃える / bottom: 底面z=0のまま
  const zOf = (m: Model)=> (align==='center') ? (mz/2 - m.size.z/2) : 0;
  const gap = state.layoutGap;
  if(state.layout === 'row'){
    const totalW = models.reduce((s,m)=> s + m.size.x, 0) + gap*Math.max(models.length-1,0);
    let x = -totalW/2;
    for(const m of models){
      m.group.position.set(x + m.size.x/2, 0, zOf(m));
      x += m.size.x + gap;
    }
  } else if(state.layout === 'grid'){
    const columns = Math.ceil(Math.sqrt(models.length));
    const rows = Math.ceil(models.length / columns);
    const cellX = Math.max(...models.map(m=>m.size.x)) + gap;
    const cellY = Math.max(...models.map(m=>m.size.y)) + gap;
    models.forEach((m, index)=>{
      const col = index % columns, row = Math.floor(index / columns);
      m.group.position.set((col-(columns-1)/2)*cellX, ((rows-1)/2-row)*cellY, zOf(m));
    });
  } else {
    for(const m of models) m.group.position.set(0, 0, zOf(m));
  }
  // グリッド/クリップ範囲を全体に合わせる
  const overall = overallSize();
  rebuildGrid(Math.max(overall.x, overall.y, overall.z));
  setupClipRange();
}
function maxZ(){ return models.length ? Math.max(...models.map(m=>m.size.z)) : 0; }
function overallSize(){
  if(!models.length) return new THREE.Vector3(80,80,80);
  const box = new THREE.Box3();
  for(const m of models){
    m.group.updateMatrixWorld(true);
    const b = m.geometry.boundingBox!.clone().applyMatrix4(m.group.matrixWorld);
    box.union(b);
  }
  const s = new THREE.Vector3(); box.getSize(s); return s;
}

// ---------- モデル一覧UI ----------
function renderList(){
  document.getElementById('mcount')!.textContent = models.length ? `(${models.length})` : '';
  const f = (n: number)=> n.toLocaleString('en-US');
  modelCards.set(models.map((m)=>{
    const hex = '#'+m.color.toString(16).padStart(6,'0');
    if(m.isGcode){
      return {
        id:m.id, name:m.name, isGcode:true, color:hex, visible:m.visible, thumb:m.thumb||null,
        details:[
          { label:'レイヤー', value:String(m.nLayers) }, { label:'時間', value:m.header?.printTime||'—' },
          { label:'X', value:m.size.x.toFixed(1) }, { label:'Y', value:m.size.y.toFixed(1) },
          { label:'Z', value:m.size.z.toFixed(1) }, { label:'重量', value:m.header?.filWeight?m.header.filWeight.toFixed(1)+'g':'—' },
        ],
      };
    }
    return {
      id:m.id, name:m.name, isGcode:false, color:hex, visible:m.visible, thumb:m.thumb||null,
      details:[
        { label:'三角形', value:f(m.tri) }, { label:'頂点', value:f(m.vert) },
        { label:'X', value:m.size.x.toFixed(1) }, { label:'Y', value:m.size.y.toFixed(1) },
        { label:'Z', value:m.size.z.toFixed(1) }, { label:'体積', value:(m.vol/1000).toFixed(1)+'cm³' },
      ],
    };
  }));
}

window.addEventListener('viewer:model-action', (event)=>{
  const { id, action, value } = (event as CustomEvent).detail || {};
  const m = models.find(model=>model.id===id);
  if(!m) return;
  if(action==='select'){ setSelectedModel(m.id); return; }
  if(action==='activate' && m.isGcode){ setSelectedModel(m.id); activeGcode = m; buildGcodePanel(m); return; }
  if(action==='cycle-color' && !m.isGcode){
    m.color = PALETTE[(PALETTE.indexOf(m.color)+1) % PALETTE.length];
    // インポート色（頂点カラー）を持つモデルは、ユーザーが明示的に色を選んだら単色に切替える。
    if(m.mat!.vertexColors){ m.mat!.vertexColors=false; m.mat!.needsUpdate=true; }
    m.mat!.color.set(m.color); refreshModelLabel(m); setSelectedModel(m.id); renderList(); return;
  }
  if(action==='set-visible'){
    m.visible = !!value; setSelectedModel(m.id); applyDisplay(); renderList(); return;
  }
  if(action==='remove') removeModel(m);
});

// ---------- 表示切替 ----------
function applyDisplay(){
  const planes = state.clip ? [clipPlane] : [];
  normalMat.clippingPlanes = planes; backfaceRed.clippingPlanes = planes;
  const hasGcode = models.some(m=> m.isGcode);
  for(const m of models){
    m.group.visible = m.visible;
    if(m.isGcode){
      for(const lo of m.lineObjs!){ lo.obj.visible = m.featVisible!.get(lo.feature)!; lo.mat.clippingPlanes = planes; }
      if(m.travelObj){ m.travelObj.visible = gcShowTravel; (m.travelObj.material as THREE.Material).clippingPlanes = planes; }
      applyGcodeLayer(m);
      continue;
    }
    // gcodeがある時にゴースト指定なら、メッシュを薄く重ねてオーバーレイ比較
    const ghost = gcGhost && hasGcode;
    m.mesh!.visible = state.solid || state.normal;
    m.mesh!.material = state.normal ? normalMat : m.mat!;
    m.mat!.clippingPlanes = planes;
    const transp = state.opacity || ghost;
    m.mat!.transparent = transp; m.mat!.opacity = ghost ? 0.18 : (state.opacity ? 0.45 : 1.0); m.mat!.depthWrite = !transp;
    if(state.wire) ensureWire(m);
    if(state.edges) ensureEdges(m);
    if(m.wire)  m.wire.visible  = state.wire;
    if(m.edges) m.edges.visible = state.edges;
    m.backface!.visible = state.backface;
    m.box!.visible = state.box;
  }
  updateModelDecorations();
}

const bind = (id: string, key2: StateBoolKey, after?: ()=>void)=> document.getElementById(id)!.addEventListener('change', e=>{
  state[key2] = (e.target as HTMLInputElement).checked; applyDisplay(); if(after) after();
});
bind('cSolid','solid');
bind('cWire','wire', ()=> notifySkipped('wire', 'ワイヤーフレーム'));
bind('cEdges','edges', ()=> notifySkipped('edges', 'エッジ'));
function notifySkipped(key2: 'wire' | 'edges', label: string){
  if(!state[key2]) return;
  const skipped = models.filter(m=> m[key2] === false).map(m=> m.name);
  if(skipped.length) notify(`${label}は三角形数が多すぎるモデルでは省略されます（${(WIRE_TRI_LIMIT/1e6)}M超）\n${skipped.join('\n')}`, { level:'warning', duration:10000 });
}
bind('cNormal','normal'); bind('cBackface','backface'); bind('cOpacity','opacity');
bind('cClip','clip'); bind('cClipFlip','clipFlip', updateClip); bind('cBox','box');
bind('cLabels','labels');
function setLayout(layout: string, fit=false){
  state.layout = layout;
  (document.getElementById('layoutSel') as HTMLSelectElement).value = layout;
  relayout();
  if(fit) fitView();
}
document.getElementById('layoutSel')!.addEventListener('change', e=> setLayout((e.target as HTMLSelectElement).value, true));
document.getElementById('layoutGap')!.addEventListener('input', e=>{
  state.layoutGap = parseFloat((e.target as HTMLInputElement).value);
  document.getElementById('layoutGapLabel')!.textContent = `${state.layoutGap} mm`;
  relayout();
});
document.getElementById('alignSel')!.addEventListener('change', ()=>{ relayout(); fitView(); });
document.getElementById('cGrid')!.addEventListener('change', e=>{ gridVisible = (e.target as HTMLInputElement).checked; grid!.visible = gridVisible; axes.visible = gridVisible; });
let spin = false;
document.getElementById('cSpin')!.addEventListener('change', e=> spin = (e.target as HTMLInputElement).checked);

// ---------- 断面クリップ ----------
let clipMin=0, clipMax=1;
function setupClipRange(){
  const s = overallSize();
  clipMin = 0; clipMax = s.z;   // 床(z=0)〜全体高さ
  updateClip();
}
function updateClip(){
  const t = parseFloat((document.getElementById('clipPos') as HTMLInputElement).value);
  const z = clipMin + (clipMax-clipMin)*t;
  if(state.clipFlip){ clipPlane.normal.set(0,0,1); clipPlane.constant = -z; }
  else { clipPlane.normal.set(0,0,-1); clipPlane.constant = z; }
}
document.getElementById('clipPos')!.addEventListener('input', updateClip);

// ---------- 背景 ----------
const bgSel = document.getElementById('bgSel') as HTMLSelectElement;
bgSel.onchange = ()=>{
  const v = bgSel.value;
  scene.background = (v==='grad') ? makeGrad() : new THREE.Color(v);
};
function makeGrad(){
  const c = document.createElement('canvas'); c.width=2; c.height=256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createLinearGradient(0,0,0,256);
  g.addColorStop(0,'#2a3550'); g.addColorStop(1,'#0d0f14');
  ctx.fillStyle=g; ctx.fillRect(0,0,2,256);
  return new THREE.CanvasTexture(c);
}
scene.background = new THREE.Color(0x1a1c20);

// ---------- 定規（メッシュ表面の2点間距離） ----------
const measureGroup = new THREE.Group(); scene.add(measureGroup);
const measureRay = new THREE.Raycaster();
const measureInfo = document.getElementById('measureInfo')!;
const measureHint = document.getElementById('measureHint')!;
let measureActive = false;
let measureStart: MeasureStart | null = null;
let measurePointerDown: { x: number; y: number } | null = null;

function disposeMeasureObject(object: THREE.Object3D){
  object.traverse(child=>{
    const c = child as THREE.Mesh;
    if(c.geometry) c.geometry.dispose();
    if(c.material){
      const materials = Array.isArray(c.material) ? c.material : [c.material];
      materials.forEach(material=>material.dispose());
    }
  });
}
function clearMeasure(){
  while(measureGroup.children.length){
    const object = measureGroup.children.pop()!;
    disposeMeasureObject(object);
  }
  measureStart = null;
  measureInfo.textContent = measureActive
    ? 'モデル表面を1点目、続けて2点目の順にクリックしてください。'
    : '有効にすると、モデル表面を2点クリックして距離を測れます。';
}
function addMeasureMarker(point: THREE.Vector3, color: number){
  const size = Math.max(0.35, Math.min(2, Math.max(overallSize().x, overallSize().y, overallSize().z) / 120));
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(size, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest:false })
  );
  marker.position.copy(point); marker.renderOrder = 10;
  measureGroup.add(marker);
}
function formatMeasurePoint(point: THREE.Vector3){ return `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)}) mm`; }
function pickMeasurePoint(event: PointerEvent){
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const candidates = models.filter(m=>!m.isGcode && m.visible && m.mesh!.visible).map(m=>m.mesh!);
  measureRay.setFromCamera(pointer, camera);
  const hit = measureRay.intersectObjects(candidates, false)[0];
  if(!hit){
    measureInfo.textContent = 'メッシュ表面をクリックしてください（G-codeの線は計測対象外です）。';
    return;
  }
  const model = models.find(m=>m.mesh === hit.object);
  if(!measureStart){
    clearMeasure();
    measureStart = { point:hit.point.clone(), model };
    addMeasureMarker(hit.point, 0xffb347);
    measureInfo.textContent = `始点 ${formatMeasurePoint(hit.point)}。2点目をクリックしてください。`;
    return;
  }

  const end = hit.point.clone();
  const delta = end.clone().sub(measureStart.point);
  const distance = delta.length();
  const horizontal = Math.hypot(delta.x, delta.y);
  addMeasureMarker(end, 0x57d2d2);
  const lineGeometry = new THREE.BufferGeometry().setFromPoints([measureStart.point, end]);
  const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color:0xffffff, depthTest:false }));
  line.renderOrder = 9; measureGroup.add(line);
  const layoutWarning = measureStart.model !== model && state.layout !== 'overlay'
    ? '　※別モデル間のため、表示用の配置間隔を含む距離です。' : '';
  measureInfo.textContent = `距離 ${distance.toFixed(2)} mm　ΔX ${Math.abs(delta.x).toFixed(2)}　ΔY ${Math.abs(delta.y).toFixed(2)}　ΔZ ${Math.abs(delta.z).toFixed(2)}　水平 ${horizontal.toFixed(2)} mm${layoutWarning}`;
  // 次のクリックは新しい計測として開始する。
  measureStart = null;
}
function setMeasureActive(active: boolean){
  measureActive = active;
  renderer.domElement.style.cursor = active ? 'crosshair' : '';
  measureHint.classList.toggle('show', active);
  measureHint.textContent = '定規: モデル表面を2点クリック\n（次のクリックで新しい計測を開始）';
  clearMeasure();
}
document.getElementById('cMeasure')!.addEventListener('change', event=> setMeasureActive((event.target as HTMLInputElement).checked));
document.getElementById('clearMeasure')!.onclick = clearMeasure;
renderer.domElement.addEventListener('pointerdown', event=>{
  if(event.button===0) measurePointerDown = { x:event.clientX, y:event.clientY };
});
renderer.domElement.addEventListener('pointerup', event=>{
  if(!measureActive || event.button!==0 || !measurePointerDown) return;
  const moved = Math.hypot(event.clientX-measurePointerDown.x, event.clientY-measurePointerDown.y);
  measurePointerDown = null;
  if(moved < 4) pickMeasurePoint(event);
});

// ---------- モデル選択（キャンバスクリック ↔ Svelteモデル一覧） ----------
const selectionRay = new THREE.Raycaster(); selectionRay.params.Line!.threshold = 0.8;
let selectionPointerDown: { x: number; y: number } | null = null;
function selectModelAt(event: PointerEvent){
  const rect = renderer.domElement.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  const candidates: THREE.Object3D[] = [];
  for(const m of models){
    if(!m.visible) continue;
    if(m.isGcode) candidates.push(...m.lineObjs!.filter(lo=>lo.obj.visible).map(lo=>lo.obj));
    else candidates.push(m.mesh!);
  }
  selectionRay.setFromCamera(pointer, camera);
  const hit = selectionRay.intersectObjects(candidates, false)[0];
  if(!hit) return;
  const model = models.find(m=> m.mesh===hit.object || m.lineObjs?.some(lo=>lo.obj===hit.object));
  if(model) setSelectedModel(model.id);
}
renderer.domElement.addEventListener('pointerdown', event=>{
  if(event.button===0) selectionPointerDown = { x:event.clientX, y:event.clientY };
});
renderer.domElement.addEventListener('pointerup', event=>{
  if(measureActive || event.button!==0 || !selectionPointerDown) return;
  const moved = Math.hypot(event.clientX-selectionPointerDown.x, event.clientY-selectionPointerDown.y);
  selectionPointerDown = null;
  if(moved < 4) selectModelAt(event);
});

// ---------- 視点 ----------
document.querySelectorAll('[data-view]').forEach(b=> (b as HTMLElement).onclick = ()=> setView((b as HTMLElement).dataset.view as string));
function overallBox(){
  const box = new THREE.Box3();
  if(!models.length){ box.set(new THREE.Vector3(-40,-40,0), new THREE.Vector3(40,40,80)); return box; }
  for(const m of models){
    m.group.updateMatrixWorld(true);
    box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.group.matrixWorld));
  }
  return box;
}
function setView(kind: string){
  const box = overallBox();
  const c = new THREE.Vector3(); box.getCenter(c);
  const r = box.getBoundingSphere(new THREE.Sphere()).radius;
  const d = r / Math.tan(THREE.MathUtils.degToRad(camera.fov/2)) * 1.3;
  const dirs: Record<string, number[]> = { iso:[1,-1,0.8], front:[0,-1,0], top:[0,0.0001,1], right:[1,0,0], fit:[1,-1,0.8] };
  const v = new THREE.Vector3(...((dirs[kind]||dirs.iso) as [number, number, number])).normalize();
  camera.position.copy(c).add(v.multiplyScalar(d));
  controls.target.copy(c);
  controls.update();
}
function fitView(){ setView('iso'); }

// ダブルクリックした点を視点の原点（回転・ズームの中心）にする。クリック先が空なら無視。
const _recenterRay = new THREE.Raycaster(); _recenterRay.params.Line!.threshold = 0.8;
renderer.domElement.addEventListener('dblclick', (e)=>{
  if(measureActive) return;  // 計測中はダブルクリックを取らない
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX-rect.left)/rect.width)*2 - 1,
    -((e.clientY-rect.top)/rect.height)*2 + 1,
  );
  _recenterRay.setFromCamera(ndc, camera);
  const objs: THREE.Object3D[] = [];
  for(const m of models){ if(!m.visible) continue; objs.push(m.isGcode ? m.group : m.mesh!); }
  const hits = _recenterRay.intersectObjects(objs, true);
  if(!hits.length) return;
  // カメラ位置は保ったまま target だけ移動 → その点を中心に回り込める
  controls.target.copy(hits[0].point);
  controls.update();
});

// ---------- ループ ----------
function resize(){
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w,h); camera.aspect = w/h; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize); resize();

let _lastT = performance.now();
function animate(){
  requestAnimationFrame(animate);
  const now = performance.now(), dt = Math.min((now-_lastT)/1000, 0.1); _lastT = now;
  tickPlayback(dt);
  if(spin){ for(const m of models) m.group.rotation.z += 0.005; }
  controls.update();
  renderer.render(scene, camera);
}
// 同一オリジンで公開済みのファイルは ?model=foo.stl / ?gcode=plate.gcode（各複数可）で自動ロードできる。
{
  const q = new URLSearchParams(location.search);
  const urls = [...q.getAll('model'), ...q.getAll('gcode')];
  if(urls.length) (async ()=>{
    try {
      for(const url of urls) await loadUrl(url);
      fitView();
    } catch(error){
      console.error(error);
      notify(`URLからの読込に失敗しました\n${(error as Error).message}`, { level:'error', duration:9000 });
    }
  })();
}
animate();
