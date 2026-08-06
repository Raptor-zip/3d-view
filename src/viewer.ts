import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { loadUrdf, setJoint, type UrdfRobot } from './urdf';
import { robotCards } from './lib/joints';
import * as fflate from 'three/addons/libs/fflate.module.js';
import { notify } from './lib/notifications';
import { modelCards, selectedModelId as selectedModelIdStore } from './lib/models';
import { prestartStepFiles, stepToGlbCached, warmupStepEngine } from './step-loader';
import type { StepPreviewInfo, StepProgress } from './step-occ';

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
interface MeshPartRange { start: number; count: number; }
interface MeshPartSpec {
  name: string;
  ranges: MeshPartRange[];
  tri: number;
  color?: number;
}
interface ParsedMesh {
  geometry: THREE.BufferGeometry;
  parts?: MeshPartSpec[];
  // 途中経過(プレビュー)モデルを出していた場合、その表示状態を本番モデルへ引き継ぐ
  previous?: PreviousState | null;
}
interface ModelPart extends MeshPartSpec {
  visible: boolean;
  mat: THREE.MeshStandardMaterial;
  normalMat: THREE.MeshNormalMaterial;
  backfaceMat: THREE.MeshBasicMaterial;
}
interface PreviousState {
  color: number;
  visible: boolean;
  curLayer?: number;
  featVisible: Map<string, boolean> | null;
  index: number;
  id: number;
  selected: boolean;
  mtime?: number | null;
  partVisible: Map<string, boolean> | null;
  fromPreview?: boolean;   // 途中経過モデルの差し替え：カメラを動かさない目印
}
interface LoadOptions {
  name?: string;
  progress?: string;
  sourceKey?: string;
  sourceUrl?: string;
  previous?: PreviousState | null;
  mtime?: number | null;
  parts?: MeshPartSpec[];
  meshes?: Map<string, File>;   // URDF が参照するメッシュの引き当て表（同じバッチのファイル）
  quiet?: boolean;        // 統計トーストを出さない（途中経過モデル用）
}
interface ParseOptions {
  // 重いSTEPで「途中経過モデル」を先に出してよいか（差し替え対象が既にある場合は出さない）
  allowPreview?: boolean;
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
  selected: Set<string>;   // 表示・監視するモデルの相対パス（プレビュー選択GUIで確定）
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
  mtime?: number | null;   // ファイル更新日時（epoch ms）
  opacity?: number;        // モデルごとの不透明度（0..1、既定1）
  basePos?: THREE.Vector3; // レイアウトで決まる基準位置
  userPos?: THREE.Vector3; // 手動移動オフセット（基準位置に加算）
  userRot?: THREE.Euler;   // 手動回転
  // メッシュモデル専用
  mesh?: THREE.Mesh;
  wire?: THREE.LineSegments | null | false;
  edges?: THREE.LineSegments | null | false;
  box?: THREE.Box3Helper;
  backface?: THREE.Mesh;
  mat?: THREE.MeshStandardMaterial;
  parts?: ModelPart[];
  flat?: boolean;          // 面法線をシェーダで求める（頂点マージ済み）モデル
  // URDF（関節つき）モデル専用
  isRobot?: boolean;
  robot?: UrdfRobot;
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
renderer.localClippingEnabled = true;   // ピクセル比は resize()/applyPixelRatio() が設定する
viewEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
// 透視（遠近感あり）と平行（直交＝パース無し）の2台を持ち、camera は今アクティブな方を指す。
// 切替時に位置・注視点・見かけの大きさを引き継ぐ（setProjection）。
const PERSP_FOV = 45;
const perspCamera = new THREE.PerspectiveCamera(PERSP_FOV, 1, 0.01, 1e6);
const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
for(const c of [perspCamera, orthoCamera]){ c.up.set(0,0,1); c.position.set(120,-120,90); }   // Z-up（CAD/STL慣習）
let camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspCamera;
let orthoView = false;
let orthoHalfH = 100;   // 平行投影の上下半幅（ワールド単位）。ズームは camera.zoom で別管理。

// ---------- near/far の動的調整（深度バッファ精度） ----------
// near=0.01 / far=1e6 の固定値だと比が 1e8 になり、24bit深度の分解能が数十mmまで落ちる。
// 数mを超えるモデル（ロボコンのフィールド等）では板厚が深度差として表現できず、
// 面がランダムに前後して「モデルがバラバラの三角形になる」ように見える（Zファイティング）。
// 実際に見えている範囲（注視点までの距離とシーン半径）に錐台を毎フレーム合わせて精度を確保する。
let sceneRadius = 100;   // シーン全体のおおよその半径（グリッド込み）。rebuildGrid が更新する。
function updateCameraClip(){
  const dist = camera.position.distanceTo(controls.target) || 1;
  const depth = Math.max(dist + sceneRadius*2, sceneRadius, 1);
  if(camera === perspCamera){
    // near は距離の 1/200。注視点より手前に来る面は dist-半径 までなので実用上クリップしない。
    const near = Math.max(dist/200, 0.01);
    if(perspCamera.near !== near || perspCamera.far !== depth){
      perspCamera.near = near; perspCamera.far = depth; perspCamera.updateProjectionMatrix();
    }
  } else {
    // 平行投影の深度は線形。前後対称に必要な分だけ取る。
    if(orthoCamera.far !== depth || orthoCamera.near !== -depth){
      orthoCamera.near = -depth; orthoCamera.far = depth; orthoCamera.updateProjectionMatrix();
    }
  }
}

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
  sceneRadius = Math.max(half*Math.SQRT2, maxDim, 100);
}
rebuildGrid(80);

// ---------- 共有マテリアル ----------
const clipPlane = new THREE.Plane(new THREE.Vector3(0,0,-1), 0);
const normalMat = new THREE.MeshNormalMaterial({ side:THREE.DoubleSide });
// 頂点マージ済み（法線属性を持たない）モデル用。面法線をフラグメントシェーダで求める。
const flatNormalMat = new THREE.MeshNormalMaterial({ side:THREE.DoubleSide, flatShading:true });
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
// 軽量表示：無劣化（三角形を減らさない）最適化のみ。読み込み時の頂点マージと、視点操作中の解像度低下。
let lite = true;
// オンデマンド描画の要求フレーム数。invalidate() は初期化中のどこからでも呼ばれ得るのでここで宣言する。
let renderRequests = 1;
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
      // 名前ラベルは複数モデルの区別が目的。1個のときは不要なので出さない。
      m.label.visible = state.labels && m.visible && models.length >= 2;
      m.label.material.opacity = selectedModelId==null || m.id===selectedModelId ? 1 : 0.62;
    }
  }
}
// トップ画面（ウェルカム）とパネルの表示は models の有無から導出する。
// 読み込み開始時に先回りで隠すと、失敗時に何も無い画面が残るため、成否確定後の同期のみ行う。
const hintEl = document.getElementById('hint')!;
function syncEmptyState(){
  const empty = models.length === 0;
  hintEl.style.display = empty ? '' : 'none';
  document.body.classList.toggle('empty', empty);
  if(empty) document.body.classList.remove('panel-open');   // モバイルのドロワーも閉じる
}

function setSelectedModel(id: number | null){
  selectedModelId = id;
  selectedModelIdStore.set(id);
  updateModelDecorations();
  attachGizmo();   // 選択に追従して移動/回転ギズモを付け替える
}

// ---------- 部品の調整（移動・回転ギズモ） ----------
const tcontrols = new TransformControls(camera, renderer.domElement);
tcontrols.setTranslationSnap(1);                          // 1mm スナップ
tcontrols.setRotationSnap(THREE.MathUtils.degToRad(15));  // 15° スナップ
tcontrols.setSpace('world');
scene.add(tcontrols as unknown as THREE.Object3D);
let gizmoMode: 'translate' | 'rotate' | null = null;

// ドラッグ中はオービット操作を止め、終了時にグリッド/断面範囲を更新
tcontrols.addEventListener('dragging-changed', (e: { value: unknown })=>{
  const dragging = !!e.value;
  controls.enabled = !dragging;
  if(!dragging) relayout();
});
// ギズモで動かした結果を、レイアウト基準位置からのオフセットとして記録
tcontrols.addEventListener('objectChange', ()=>{
  const m = models.find(x=> x.id===selectedModelId);
  if(!m) return;
  const base = m.basePos ?? new THREE.Vector3();
  m.userPos = m.group.position.clone().sub(base);
  m.userRot = m.group.rotation.clone();
});

// 基準位置(=レイアウト)に手動オフセット/回転を載せて反映
function applyUserTransform(m: Model){
  const b = m.basePos ?? new THREE.Vector3();
  const u = m.userPos ?? new THREE.Vector3();
  m.group.position.set(b.x+u.x, b.y+u.y, b.z+u.z);
  if(m.userRot) m.group.rotation.copy(m.userRot); else m.group.rotation.set(0,0,0);
}
function setBasePos(m: Model, x: number, y: number, z: number){
  m.basePos = new THREE.Vector3(x,y,z);
  applyUserTransform(m);
}
function attachGizmo(){
  const m = gizmoMode ? models.find(x=> x.id===selectedModelId) : undefined;
  if(m) { tcontrols.setMode(gizmoMode!); tcontrols.attach(m.group); }
  else tcontrols.detach();
  updateGizmoUI();
}
function setGizmoMode(mode: 'translate' | 'rotate' | null){ gizmoMode = mode; attachGizmo(); }
function updateGizmoUI(){
  const m = models.find(x=> x.id===selectedModelId);
  document.getElementById('gizmoName')!.textContent = m ? m.name : '';
  for(const [id, mode] of [['gizMove','translate'],['gizRotate','rotate']] as const){
    document.getElementById(id)!.classList.toggle('active', gizmoMode===mode);
  }
  const hint = document.getElementById('gizHint')!;
  hint.textContent = !m ? 'モデルを選択してから「移動」か「回転」を押すとギズモが出ます。'
    : gizmoMode ? `「${m.name}」を${gizmoMode==='translate'?'移動':'回転'}中。キャンバスのギズモをドラッグ。`
    : 'モデルを選択中。「移動」か「回転」を押すとギズモが出ます。';
}
document.getElementById('gizMove')!.onclick = ()=> setGizmoMode('translate');
document.getElementById('gizRotate')!.onclick = ()=> setGizmoMode('rotate');
document.getElementById('gizOff')!.onclick = ()=> setGizmoMode(null);
document.getElementById('gizReset')!.onclick = ()=>{
  const m = models.find(x=> x.id===selectedModelId);
  if(!m) return;
  m.userPos = undefined; m.userRot = undefined;
  applyUserTransform(m); relayout();
};
(document.getElementById('gizSnap') as HTMLInputElement).onchange = (e)=>{
  const on = (e.target as HTMLInputElement).checked;
  tcontrols.setTranslationSnap(on ? 1 : null);
  tcontrols.setRotationSnap(on ? THREE.MathUtils.degToRad(15) : null);
};
(document.getElementById('gizSpace') as HTMLSelectElement).onchange = (e)=>
  tcontrols.setSpace((e.target as HTMLSelectElement).value as 'world' | 'local');

// ---------- ファイル読み込み ----------
const busy = document.getElementById('busy')!;
const busyText = document.getElementById('busyText')!;
const showBusy = (s: string | null)=>{ busy.classList.toggle('show', !!s); if(s) busyText.textContent = s; };

// 1ファイルの読み込み開始時刻。統計トーストで所要時間を出すためだけに持つ。
let loadStartAt: number | null = null;
const markLoadStart = ()=>{ loadStartAt = performance.now(); };
const loadElapsedSec = ()=> loadStartAt === null ? null : (performance.now() - loadStartAt) / 1000;
const nextFrame = ()=> new Promise(r=> requestAnimationFrame(()=> requestAnimationFrame(r)));

// 監視（自動更新）は File System Access API 依存で Chrome/Edge のみ。
// 未対応ブラウザ（Safari/Firefox）では監視ボタンを出さず、「フォルダーを開く（一回）」へ誘導する。
// 自動更新（1秒ポーリング）は File System Access API の永続ハンドルが要る＝Chrome/Edge のみ。
// 「フォルダーを開く」は対応ブラウザではハンドル取得（フォルダーごとに自動更新トグル可）、
// 非対応ブラウザ(Safari/Firefox)では webkitdirectory による一回読み込みへ自動フォールバックする。
const WATCH_SUPPORTED = typeof window.showDirectoryPicker === 'function';
const openFolder = ()=> WATCH_SUPPORTED ? selectBrowserDirectory() : document.getElementById('folderInput')!.click();
document.getElementById('openFolderBtn')!.onclick = openFolder;
document.getElementById('heroFolderBtn')!.onclick = openFolder;   // トップ画面のフォルダーCTA
// モバイル：設定パネル（ドロワー）の開閉
document.getElementById('panelToggle')!.onclick = ()=> document.body.classList.toggle('panel-open');
document.getElementById('panelBackdrop')!.onclick = ()=> document.body.classList.remove('panel-open');
document.getElementById('folderInput')!.onchange = async (e)=>{
  const files = [...(e.target as HTMLInputElement).files!]; (e.target as HTMLInputElement).value='';
  if(!files.length) return;
  await loadFiles(files);
  if(models.length > 1) setLayout('grid', true);
};

// サンプル表示：ファイルが無くてもワンクリックで操作（回転/陰影/断面/計測等）を試せる。
// 同梱ファイルを増やさないよう、ブラウザ内で生成したジオメトリを直接読み込む。
document.getElementById('heroSampleBtn')!.onclick = ()=>{
  if(models.some(m=> m.sourceKey === 'sample:knot')) return;  // 二重追加を防ぐ
  const geo = new THREE.TorusKnotGeometry(16, 5, 240, 36);
  geo.rotateX(Math.PI/2);
  addModel('サンプル（トーラスノット）', geo, { sourceKey:'sample:knot' });
};

const drop = document.getElementById('drop')!;
// ドラッグ中はオーバーレイ表示に加え、body.dragging でウェルカムカード枠も点灯させる。
function setDragging(on: boolean){ drop.classList.toggle('show', on); document.body.classList.toggle('dragging', on); }
window.addEventListener('dragover', e=>{ e.preventDefault(); setDragging(true); });
window.addEventListener('dragleave', e=>{ if(e.relatedTarget===null) setDragging(false); });
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
  e.preventDefault(); setDragging(false);
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

// URDF は `<mesh filename="meshes/x.stl">` のように**外部ファイルを参照する**。
// ブラウザには相対パスを辿る手段が無いので、同じバッチ（フォルダードロップや
// 複数選択）で来たファイルを名前で引ける表にしておき、そこから解決する。
// ⚠ フォルダーごと入れてもらう必要がある。urdf 単体では形が出ない。
function normalizeRelPath(path: string){
  const out: string[] = [];
  for(const seg of path.split('/')){
    if(!seg || seg === '.') continue;
    if(seg === '..'){ out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/').toLowerCase();
}
// バッチ内のファイルを「相対パス」と「ファイル名だけ」の両方で引ける表にする。
function urdfMeshTable(entries: DirFile[]){
  const table = new Map<string, File>();
  for(const { path, file } of entries){
    const key = normalizeRelPath(path);
    table.set(key, file);
    const base = key.split('/').pop()!;
    if(!table.has(base)) table.set(base, file);   // 名前が重なったら相対パス側を優先
  }
  return table;
}
function fileMeshTable(files: File[]){
  return urdfMeshTable(files.map(file=> ({
    path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file,
  })));
}
// urdf に書かれた参照を表の鍵の候補へ展開する。urdf 自身の位置からの相対を先に見て、
// 駄目ならファイル名だけで引く。`package://pkg/meshes/x.stl` はパッケージ名も落として試す。
function urdfMeshCandidates(filename: string, baseDir: string){
  const rel = filename.replace(/^(package|model|file):\/\//, '');
  const keys: string[] = [];
  for(const cand of [rel, rel.split('/').slice(1).join('/')]){
    if(!cand) continue;
    if(baseDir) keys.push(normalizeRelPath(`${baseDir}/${cand}`));
    keys.push(normalizeRelPath(cand));
  }
  keys.push(normalizeRelPath(rel.split('/').pop()!));
  return keys;
}
// maxBytes はプレビュー用の読み込み量の上限。超えた分は解決せず（＝欠けたまま）返す。
function urdfMeshResolver(table: Map<string, File>, baseDir: string, maxBytes = Infinity){
  let remaining = maxBytes;
  return async (filename: string): Promise<THREE.BufferGeometry | null> => {
    let file: File | undefined;
    for(const key of urdfMeshCandidates(filename, baseDir)){
      file = table.get(key);
      if(file) break;
    }
    if(!file || file.size > remaining) return null;
    remaining -= file.size;
    const ext = file.name.split('.').pop()!.toLowerCase();
    const buf = await file.arrayBuffer();
    if(ext === 'stl') return new STLLoader().parse(buf);
    if(ext === 'obj' || ext === '3mf' || ext === 'glb' || ext === 'gltf'){
      const parsed = await parseBufferWithParts(buf, file.name);
      return parsed.geometry;
    }
    return null;
  };
}

async function loadFiles(files: File[]){
  const meshes = fileMeshTable(files);
  // 表示は順番どおりでも、STEPの変換だけ先に並行で走らせる（変換済みならキャッシュを使うので
  // ここでwasmを取りに行かない＝STEPが全部キャッシュ済みなら13MBのwasmは不要）。
  prestartSteps(files);
  // バッチ内に result.json があれば gcode の統計として使う
  let resultJson: ResultJson | null = null;
  const rf = files.find(f=> /(^|\/)result\.json$/i.test(f.name) || f.name.toLowerCase()==='result.json');
  if(rf){ try { resultJson = JSON.parse(await rf.text()); } catch(e){ console.warn('result.json 解析失敗', e); } }
  for(let i=0;i<files.length;i++){
    await loadLocalFile(files[i], resultJson, { progress:`${i+1}/${files.length}`, meshes });
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
  const mtime = file.lastModified || null;   // ファイル更新日時（epoch ms）
  showBusy(`読み込み中${prefix}… ${name} (${mb} MB)`);
  markLoadStart();
  await nextFrame();
  try {
    if(ext === 'urdf'){
      const robot = await loadUrdf(await file.text(), {
        resolveMesh: urdfMeshResolver(options.meshes ?? fileMeshTable([file]), parentPath(name)),
      });
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(options.sourceKey);
      addRobot(name, robot, { sourceKey:options.sourceKey, previous, mtime });
      if(robot.missing.length){
        notify(`メッシュが見つかりません: ${robot.missing.slice(0,3).join(', ')}`
          + (robot.missing.length>3 ? ` ほか${robot.missing.length-3}件` : '')
          + ' — urdf とメッシュはフォルダーごと入れてください',
          { level:'warning', duration:9000 });
      }
      return true;
    }
    if(ext === 'gcode'){
      const parsed = parseGcode(await file.text());
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(options.sourceKey);
      addGcode(name, parsed, resultJson, { sourceKey:options.sourceKey, previous, mtime });
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
        addGcode(name, parsed, resultJson || ex.resultJson, { sourceKey:options.sourceKey, previous, mtime });
        return true;
      }
      const parsedMesh = await parseBufferWithParts(buffer, name);
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(options.sourceKey);
      addModel(name, parsedMesh.geometry, { sourceKey:options.sourceKey, previous, mtime, parts:parsedMesh.parts });
      return true;
    }
    // 差し替え対象（前回の版）が既に画面にあるなら、途中経過は出さずに完成まで今の表示を残す。
    const allowPreview = !options.sourceKey || !models.some(m=> m.sourceKey === options.sourceKey);
    const parsedMesh = await parseBufferWithParts(await file.arrayBuffer(), name, { allowPreview });
    showBusy(`配置中… ${name}`); await nextFrame();
    const previous = takeSourceState(options.sourceKey) ?? parsedMesh.previous ?? null;
    addModel(name, parsedMesh.geometry, { sourceKey:options.sourceKey, previous, mtime, parts:parsedMesh.parts });
    return true;
  } catch(err){
    console.error(err);
    notify(`読み込みエラー\n${name}\n${(err as Error).message}`, { level:'error', duration:9000 });
    return false;
  }
}

// 3MF を自前で解析して単一ジオメトリを返す。three.js の ThreeMFLoader は
// production 拡張（BambuStudio/OrcaSlicer が使う、メッシュを別ファイル
// 3D/Objects/*.model に分け <components p:path=...> で参照する形）を解決できず、
// ジオメトリが空になる。ここでは外部モデル参照を再帰的にたどってメッシュを合成する。
// 解析できない／メッシュが見つからない場合は null を返し、呼び出し側で従来ローダへ委譲する。
function parse3mf(buf: ArrayBuffer): THREE.BufferGeometry | null {
  let files: Record<string, Uint8Array>;
  try { files = (fflate as any).unzipSync(new Uint8Array(buf)); } catch(e){ return null; }
  const decoder = new TextDecoder();
  // zip 内のパス（先頭スラッシュ無し）に正規化して中身を引く
  const readFile = (path: string)=>{
    const key = path.replace(/^\//, '');
    return files[key] ?? files[Object.keys(files).find(k=> k.toLowerCase() === key.toLowerCase()) || ''];
  };

  // 3MF の transform（4x3, 12要素）を Matrix4 へ。ThreeMFLoader と同じ並びに合わせる。
  const parseTransform = (s: string | null)=>{
    const m = new THREE.Matrix4();
    if(!s) return m;
    const t = s.trim().split(/\s+/).map(parseFloat);
    if(t.length < 12 || t.some(Number.isNaN)) return m;
    m.set(t[0],t[3],t[6],t[9], t[1],t[4],t[7],t[10], t[2],t[5],t[8],t[11], 0,0,0,1);
    return m;
  };

  interface ObjData { mesh?: Element; components?: { path?: string; objectid: string; transform: THREE.Matrix4 }[]; }
  const modelCache = new Map<string, Map<string, ObjData>>();
  const parseModel = (path: string): Map<string, ObjData> | null =>{
    const key = path.replace(/^\//, '');
    if(modelCache.has(key)) return modelCache.get(key)!;
    const data = readFile(path);
    if(!data) return null;
    let doc: Document;
    try { doc = new DOMParser().parseFromString(decoder.decode(data), 'application/xml'); }
    catch(e){ return null; }
    // ブラウザの XML DOM（デフォルト名前空間あり）では子結合子 `>` を使うと
    // セレクタが要素を拾えないことがある。ThreeMFLoader と同じく結合子無しの
    // 型セレクタ（局所名一致）だけで走査する。object はトップレベルのみ存在。
    const objects = new Map<string, ObjData>();
    for(const obj of Array.from(doc.querySelectorAll('object'))){
      const id = obj.getAttribute('id'); if(!id) continue;
      const mesh = obj.querySelector('mesh') as Element | null;
      const compsNode = obj.querySelector('components');
      if(compsNode){
        const components = Array.from(compsNode.querySelectorAll('component')).map(c=>({
          // p:path は名前空間付き属性。getAttribute('p:path') は環境差があるため両系統を見る。
          path: c.getAttribute('p:path') || c.getAttributeNS('http://schemas.microsoft.com/3dmanufacturing/production/2015/06','path') || undefined,
          objectid: c.getAttribute('objectid') || '',
          transform: parseTransform(c.getAttribute('transform')),
        }));
        objects.set(id, { mesh: mesh || undefined, components });
      } else {
        objects.set(id, { mesh: mesh || undefined });
      }
    }
    modelCache.set(key, objects);
    return objects;
  };

  const positions: number[] = [];
  const v = new THREE.Vector3();
  // 1つのメッシュ要素を matrix 適用して positions へ積む（非インデックス三角形列）
  const emitMesh = (mesh: Element, matrix: THREE.Matrix4)=>{
    const verts: number[] = [];
    for(const vert of Array.from(mesh.querySelectorAll('vertex'))){
      verts.push(+vert.getAttribute('x')!, +vert.getAttribute('y')!, +vert.getAttribute('z')!);
    }
    for(const tri of Array.from(mesh.querySelectorAll('triangle'))){
      for(const a of ['v1','v2','v3'] as const){
        const i = +tri.getAttribute(a)! * 3;
        v.set(verts[i], verts[i+1], verts[i+2]).applyMatrix4(matrix);
        positions.push(v.x, v.y, v.z);
      }
    }
  };

  const seen = new Set<string>();   // path|id の再帰ガード（循環参照対策）
  const resolve = (modelPath: string, objectId: string, matrix: THREE.Matrix4)=>{
    const guard = `${modelPath}|${objectId}`;
    if(seen.has(guard)) return; seen.add(guard);
    const objects = parseModel(modelPath);
    const obj = objects?.get(objectId);
    if(!obj) return;
    if(obj.components){
      for(const c of obj.components){
        const childPath = c.path || modelPath;
        resolve(childPath, c.objectid, matrix.clone().multiply(c.transform));
      }
    }
    if(obj.mesh) emitMesh(obj.mesh, matrix);
    seen.delete(guard);
  };

  // ルート rels から開始パートを得る。無ければ慣習の 3D/3dmodel.model。
  let rootPath = '3D/3dmodel.model';
  const rootRels = readFile('_rels/.rels');
  if(rootRels){
    try {
      const rels = new DOMParser().parseFromString(decoder.decode(rootRels), 'application/xml');
      const node = Array.from(rels.querySelectorAll('Relationship')).find(r=>
        (r.getAttribute('Type') || '').includes('3dmodel'));
      const target = node?.getAttribute('Target'); if(target) rootPath = target;
    } catch(e){ /* 既定パスで続行 */ }
  }
  const rootModel = parseModel(rootPath);
  if(!rootModel) return null;

  // build/item を起点に解決。build が無ければ全オブジェクトを描画対象にする。
  const rootData = readFile(rootPath);
  let items: { objectid: string; transform: THREE.Matrix4 }[] = [];
  try {
    const doc = new DOMParser().parseFromString(decoder.decode(rootData!), 'application/xml');
    items = Array.from(doc.querySelectorAll('item')).map(it=>({
      objectid: it.getAttribute('objectid') || '',
      transform: parseTransform(it.getAttribute('transform')),
    }));
  } catch(e){ /* fallthrough */ }
  if(!items.length) items = [...rootModel.keys()].map(id=>({ objectid:id, transform:new THREE.Matrix4() }));

  for(const it of items) resolve(rootPath, it.objectid, it.transform);

  if(!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geometry.computeVertexNormals();
  // build の item transform はプレート上の絶対座標（例: 128,128,15）になりがちで、
  // 既存モデルと同様に中心化はせず、addModel 側の配置/グリッドに委ねる。
  return geometry;
}

// ---------- 大容量 3MF のストリーミング解析 ----------
// unzipSync + DOMParser は、展開後の .model が V8 の最大文字列長（約5.4億文字）を超えると
// TextDecoder が RangeError を投げて破綻する（例: 展開1.75GBの単一モデル）。
// ここでは圧縮入力をチャンクで流し込み、出力を分割で受けながらタグ単位で走査し、
// 頂点/三角形を直接 typed array へ展開する。単一 model 内の複数オブジェクト＋build item の
// transform に対応（外部参照 .model は対象外＝従来の parse3mf/ThreeMFLoader に委ねる）。
const LARGE_3MF_COMPRESSED = 60 * 1024 * 1024;   // これ超の3mfは危険な一括展開を避けてストリームへ直行
const TRI_HARD_CAP = 30_000_000;                 // これ超は表示不能としてストリーム解析を中止
const HEAVY_TRI_WARN = 4_000_000;                // これ超は重い旨を警告（表示は続行）

class GrowF32 { a = new Float32Array(1<<16); n = 0;
  push(v: number){ if(this.n===this.a.length){ const b=new Float32Array(this.a.length*2); b.set(this.a); this.a=b; } this.a[this.n++]=v; } }
class GrowU32 { a = new Uint32Array(1<<16); n = 0;
  push(v: number){ if(this.n===this.a.length){ const b=new Uint32Array(this.a.length*2); b.set(this.a); this.a=b; } this.a[this.n++]=v; } }

async function parse3mfStream(buf: ArrayBuffer): Promise<THREE.BufferGeometry | null> {
  const u8 = new Uint8Array(buf);
  // 空白/クオート境界を安全に切るため、属性は先頭スペース付きで探す（pid= と id= の誤取得回避）。
  const attr = (tag: string, name: string): string | null => {
    const k = tag.indexOf(' '+name+'="'); if(k<0) return null;
    const s = k + name.length + 3; const e = tag.indexOf('"', s);
    return e<0 ? null : tag.slice(s, e);
  };
  const num = (tag: string, name: string)=>{ const v = attr(tag, name); return v===null ? NaN : +v; };

  interface Obj { vx: GrowF32; idx: GrowU32; }
  const objects = new Map<string, Obj>();
  const items: { objectid: string; transform: string | null }[] = [];
  let cur: Obj | null = null;
  let triTotal = 0;
  let aborted = false;

  const handleTag = (tag: string)=>{
    const c1 = tag.charCodeAt(1);
    if(c1===118){ // 'v'
      if(tag.startsWith('<vertex') && cur){ cur.vx.push(num(tag,'x')); cur.vx.push(num(tag,'y')); cur.vx.push(num(tag,'z')); return; }
      return;
    }
    if(c1===116){ // 't'
      if(tag.startsWith('<triangle') && !tag.startsWith('<triangles') && cur){
        cur.idx.push(num(tag,'v1')); cur.idx.push(num(tag,'v2')); cur.idx.push(num(tag,'v3'));
        if(++triTotal > TRI_HARD_CAP) aborted = true;
      }
      return;
    }
    if(tag.startsWith('<object')){ const id=attr(tag,'id'); if(id){ cur={ vx:new GrowF32(), idx:new GrowU32() }; objects.set(id, cur); } return; }
    if(tag.startsWith('<item')){ const objectid=attr(tag,'objectid'); if(objectid) items.push({ objectid, transform:attr(tag,'transform') }); return; }
  };

  const dec = new TextDecoder('utf-8');
  let pending = '';
  const consume = (final: boolean)=>{
    let i = 0;
    while(true){
      const lt = pending.indexOf('<', i);
      if(lt<0){ i = pending.length; break; }
      const gt = pending.indexOf('>', lt);
      if(gt<0){ i = lt; break; }   // 途中で切れたタグ。次チャンクへ持ち越す
      handleTag(pending.slice(lt, gt+1));
      i = gt+1;
      if(aborted) break;
    }
    pending = pending.slice(i);
    void final;
  };

  const unzip = new (fflate as any).Unzip();
  unzip.register((fflate as any).UnzipInflate);
  let streamErr: Error | null = null;
  unzip.onfile = (file: any)=>{
    if(!/\.model$/i.test(file.name)) return;   // 対象は 3D/3dmodel.model 等
    file.ondata = (err: Error | null, chunk: Uint8Array, fin: boolean)=>{
      if(err){ streamErr = err; return; }
      if(aborted) return;
      pending += dec.decode(chunk, { stream: !fin });
      consume(fin);
    };
    file.start();
  };

  // 圧縮入力をチャンクで push（出力も分割）。数フレームおきに UI へ制御を返す。
  const CH = 4 << 20;   // 4MB
  const total = u8.length;
  for(let off=0; off<total; off+=CH){
    const end = Math.min(off+CH, total);
    unzip.push(u8.subarray(off, end), end>=total);
    if(streamErr || aborted) break;
    if((off / CH) % 4 === 0){ showBusy(`大容量3MFを解析中… ${Math.round(end/total*100)}%`); await nextFrame(); }
  }
  if(streamErr){ console.warn('3MFストリーム展開に失敗', streamErr); return null; }
  if(aborted){ throw new Error(`三角形が多すぎて表示できません（${TRI_HARD_CAP/1e6}M超）`); }

  // build item（無ければ全オブジェクト）を起点に、transform を適用して非インデックス頂点へ展開。
  const use = items.length ? items : [...objects.keys()].map(id=>({ objectid:id, transform:null }));
  let totalTri = 0;
  for(const it of use){ const o=objects.get(it.objectid); if(o) totalTri += o.idx.n/3; }
  if(!totalTri) return null;
  const pos = new Float32Array(totalTri*9);
  let p = 0;
  for(const it of use){
    const o = objects.get(it.objectid); if(!o) continue;
    const vx = o.vx.a, idx = o.idx.a, ni = o.idx.n;
    const t = it.transform ? it.transform.trim().split(/\s+/).map(Number) : null;
    const ident = !t || t.length<12 || (t[0]===1&&t[1]===0&&t[2]===0&&t[3]===0&&t[4]===1&&t[5]===0&&t[6]===0&&t[7]===0&&t[8]===1&&t[9]===0&&t[10]===0&&t[11]===0);
    for(let k=0;k<ni;k++){
      const vi = idx[k]*3; let x=vx[vi], y=vx[vi+1], z=vx[vi+2];
      if(!ident){
        const nx=t![0]*x+t![3]*y+t![6]*z+t![9], ny=t![1]*x+t![4]*y+t![7]*z+t![10], nz=t![2]*x+t![5]*y+t![8]*z+t![11];
        x=nx; y=ny; z=nz;
      }
      pos[p++]=x; pos[p++]=y; pos[p++]=z;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geometry.computeVertexNormals();
  if(totalTri > HEAVY_TRI_WARN){
    notify(`大きなモデルを読み込みました（三角形 ${(totalTri/1e6).toFixed(1)}M）。\n操作が重くなる場合があります。`, { level:'warning', duration:8000 });
  }
  return geometry;
}
// 3mf のメッシュ取得。通常は従来の DOM 解析、大容量（またはDOM失敗）ではストリーム解析へ。
async function parse3mfMesh(buf: ArrayBuffer): Promise<THREE.BufferGeometry | null> {
  if(buf.byteLength <= LARGE_3MF_COMPRESSED){
    const g = parse3mf(buf);
    if(g) return g;
  }
  return await parse3mfStream(buf);
}

async function parseFile(file: File){
  return parseBuffer(await file.arrayBuffer(), file.name);
}
async function parseBuffer(buf: ArrayBuffer, name: string){
  return (await parseBufferWithParts(buf, name)).geometry;
}
async function parseBufferWithParts(buf: ArrayBuffer, name: string, options: ParseOptions = {}): Promise<ParsedMesh>{
  const ext = name.split('.').pop()!.toLowerCase();
  let geometry: THREE.BufferGeometry | null = null, object: THREE.Object3D | null = null;
  if(ext === 'stl')       geometry = new STLLoader().parse(buf);
  else if(ext === 'obj')  object = new OBJLoader().parse(new TextDecoder().decode(buf));
  else if(ext === '3mf'){
    geometry = await parse3mfMesh(buf);
    // 大容量パスで取れなければ ThreeMFLoader は使わない（1.75GB等で確実に破綻するため）。
    if(!geometry && buf.byteLength <= LARGE_3MF_COMPRESSED) geometry = mergeObject(new ThreeMFLoader().parse(buf));
  }
  else if(ext === 'step' || ext === 'stp') return await loadStep(buf, name, !!options.allowPreview);
  else if(ext === 'glb' || ext === 'gltf') return await loadGltf(buf);
  else throw new Error('未対応の形式: .'+ext);
  if(object && !geometry) geometry = mergeObject(object);
  if(!geometry || !geometry.attributes.position) throw new Error('ジオメトリを取得できませんでした');
  return { geometry };
}

function sourceKeyFor(url: string){ return new URL(url, location.href).href; }
function sourceNameFor(url: string){
  const pathname = new URL(url, location.href).pathname;
  return decodeURIComponent(pathname.split('/').pop()!) || 'model';
}
// 差し替え時に引き継ぐ表示状態（色・表示/非表示・並び順・選択・部品の表示状態）。
function captureModelState(old: Model): PreviousState {
  return {
    color: old.color, visible: old.visible, curLayer: old.curLayer,
    featVisible: old.featVisible ? new Map(old.featVisible) : null, index:models.indexOf(old), id:old.id, selected:old.id===selectedModelId,
    mtime: old.mtime,
    partVisible: old.parts ? new Map(old.parts.map(part=>[part.name, part.visible])) : null,
  };
}
function takeSourceState(sourceKey: string | undefined): PreviousState | null {
  if(!sourceKey) return null;
  const old = models.find(m=>m.sourceKey === sourceKey);
  if(!old) return null;
  const keep = captureModelState(old);
  removeModel(old);
  return keep;
}

// URL(同一オリジンのHTTP配信)からモデルを取得して読み込む。sourceKey が同じ場合は成功後に置換する。
async function loadUrl(url: string, options: LoadOptions = {}){
  const sourceKey = options.sourceKey || sourceKeyFor(url);
  const name = options.name || sourceNameFor(url);
  showBusy(`読み込み中… ${name}`);
  await nextFrame();
  try {
    const res = await fetch(url, { cache:'no-store' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    // サーバが Last-Modified を返せば更新日時として使う（無ければ null）
    const lm = res.headers.get('last-modified');
    const mtime = lm ? (Date.parse(lm) || null) : null;
    if(name.split('.').pop()!.toLowerCase() === 'urdf'){
      // ⚠ メッシュは urdf からの**相対 URL**で辿る。ドロップ経由と違って
      //   フォルダーを丸ごと入れてもらう必要がない。
      const robot = await loadUrdf(await res.text(), {
        resolveMesh: async (filename)=>{
          const meshUrl = new URL(filename.replace(/^package:\/\//, ''), new URL(url, location.href)).toString();
          const r = await fetch(meshUrl, { cache:'no-store' });
          if(!r.ok) return null;
          const ext = meshUrl.split('.').pop()!.toLowerCase();
          const buf = await r.arrayBuffer();
          if(ext === 'stl') return new STLLoader().parse(buf);
          return (await parseBufferWithParts(buf, meshUrl.split('/').pop()!)).geometry;
        },
      });
      showBusy(`配置中… ${name}`); await nextFrame();
      const previous = takeSourceState(sourceKey);
      addRobot(name, robot, { sourceKey, sourceUrl:url, previous, mtime });
      if(robot.missing.length){
        notify(`メッシュが取得できません: ${robot.missing.slice(0,3).join(', ')}`,
          { level:'warning', duration:9000 });
      }
      // ⚠ ここで **showBusy(null) を自分で消す**。この関数の末尾にある
      //   showBusy(null) は try/catch の後ろにあるので、途中 return すると
      //   通らず「配置中…」が出たままになる（3mf の分岐も同じ理由で
      //   自分で消している）。
      showBusy(null);
      return true;
    }
    if(name.split('.').pop()!.toLowerCase() === 'gcode'){
      const parsed = parseGcode(await res.text());
      // 同ディレクトリの result.json を試行（無ければ無視）
      let resultJson: ResultJson | null = null;
      try {
        const rjUrl = url.replace(/[^/]+$/, 'result.json');
        const r = await fetch(rjUrl, { cache:'no-store' }); if(r.ok) resultJson = await r.json();
      } catch(e){ /* 無くてよい */ }
      const previous = takeSourceState(sourceKey);
      addGcode(name, parsed, resultJson, { sourceKey, sourceUrl:url, previous, mtime });
    } else {
      const ab = await res.arrayBuffer();
      if(name.split('.').pop()!.toLowerCase() === '3mf'){
        const ex = extractGcodeFrom3mf(ab);
        if(ex){   // スライス済み3mf（メッシュ無し）→ 内蔵gcodeを表示
          const parsed = parseGcode(ex.text);
          if(ex.weight && !parsed.header.filWeight) parsed.header.filWeight = ex.weight;
          const previous = takeSourceState(sourceKey);
          addGcode(name, parsed, ex.resultJson, { sourceKey, sourceUrl:url, previous, mtime });
          showBusy(null); return;
        }
      }
      const allowPreview = !models.some(m=> m.sourceKey === sourceKey);
      const parsedMesh = await parseBufferWithParts(ab, name, { allowPreview });
      const previous = takeSourceState(sourceKey) ?? parsedMesh.previous ?? null;
      addModel(name, parsedMesh.geometry, { sourceKey, sourceUrl:url, previous, mtime, parts:parsedMesh.parts });
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
const BROWSER_DIRECTORY_EXTENSIONS = new Set(['stl','step','stp','obj','3mf','glb','gltf','gcode','urdf']);
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
    // ⚠ URDF のメッシュは**選択されていなくても**要る。選んだモデルだけに絞る前の
    //   フォルダー全体から表を作らないと、urdf を選んでも形が出ない。
    const meshes = urdfMeshTable(found);
    const resultByDirectory = new Map<string, { value: ResultJson; stamp: string }>();
    for(const item of found){
      if(item.file.name.toLowerCase() !== 'result.json') continue;
      try {
        resultByDirectory.set(parentPath(item.path), {
          value:JSON.parse(await item.file.text()), stamp:`${item.file.lastModified}:${item.file.size}`,
        });
      } catch(error){ console.warn(`result.json 解析失敗: ${item.path}`, error); }
    }
    // 表示対象に選ばれた相対パスのモデルだけを取り込む（フォルダー全体は読み込まない）。
    const modelFiles = found.filter(item=>
      BROWSER_DIRECTORY_EXTENSIONS.has(item.file.name.split('.').pop()!.toLowerCase())
      && entry.selected.has(item.path));
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
    // 新規・更新されたモデルだけを読み直す。STEPは表示順を待たずに変換を始めておく。
    const pending = modelFiles.filter(item=>
      entry.files.get(browserSourceKey(entry, item.path)) !== next.get(browserSourceKey(entry, item.path)));
    prestartSteps(pending.map(item=> item.file));
    for(const item of pending){
      const sourceKey = browserSourceKey(entry, item.path);
      const result = resultByDirectory.get(parentPath(item.path));
      await loadLocalFile(item.file, result?.value || null, { sourceKey, name:item.path, meshes });
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
    const pick = document.createElement('button');
    pick.className = 'fi-pick'; pick.textContent = '選び直す'; pick.title = `「${entry.handle.name}」の表示モデルをプレビューから選び直す`;
    pick.onclick = ()=> reselectBrowserDirectory(entry);
    const stop = document.createElement('button');
    stop.className = 'fi-stop'; stop.textContent = '削除'; stop.title = `「${entry.handle.name}」と由来モデルを取り除く`;
    stop.onclick = ()=> stopBrowserDirectory(entry);
    row.append(name, count, watch, pick, stop);
    folderList.append(row);
  }
}
function updateBrowserDirectoryStatus(){
  const entries = [...browserDirectories.values()];
  const total = entries.reduce((sum, entry)=> sum + (entry.modelCount || 0), 0);
  renderBrowserDirectoryList();
  if(!entries.length){
    folderStatus.textContent = WATCH_SUPPORTED
      ? 'フォルダーを開いて、プレビュー一覧から見たいモデルだけを選べます（既定で自動更新・行ごとにオフ可）。'
      : 'フォルダーを開くか、ファイル／フォルダーをドラッグ&ドロップして読み込めます。';
    return;
  }
  const watching = entries.filter(entry=> entry.watch !== false).length;
  folderStatus.textContent = watching
    ? `${entries.length} フォルダー・選択 ${total} 件を表示中（${watching} フォルダーを1秒ごとに自動更新）。「選び直す」で増減できます。`
    : `${entries.length} フォルダー・選択 ${total} 件を表示中（自動更新オフ）。「選び直す」で増減できます。`;
}
// FileSystemDirectoryHandle を監視対象に登録する。ボタン選択／ドロップの両方から使う。
// フォルダー全体を読み込むのではなく、プレビュー付きの選択GUIで「見るモデル」を絞ってから取り込む。
async function addBrowserDirectoryHandle(handle: FileSystemDirectoryHandle){
  for(const entry of browserDirectories.values()){
    if(await handle.isSameEntry(entry.handle)){
      folderStatus.textContent = `「${handle.name}」はすでに監視中です。行の「選び直す」で表示モデルを変更できます。`;
      return false;
    }
  }
  const chosen = await openDirectoryPicker(handle);
  if(!chosen) return false;             // キャンセル
  if(!chosen.size){ folderStatus.textContent = `「${handle.name}」は表示モデルが選ばれなかったため開きませんでした。`; return false; }
  const entry: BrowserDirectoryEntry = { id:++browserDirectorySequence, handle, files:new Map(), selected:chosen, modelCount:0, syncing:false, timer:null, watch:true };
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
// 既存フォルダーの表示モデルを選び直す。選択集合を差し替え、外れたモデルは即座に撤去する。
async function reselectBrowserDirectory(entry: BrowserDirectoryEntry){
  const chosen = await openDirectoryPicker(entry.handle, entry.selected);
  if(!chosen) return;   // キャンセル：現状維持
  entry.selected = chosen;
  showBusy(`フォルダーを更新中… ${entry.handle.name}`);
  try { await syncBrowserDirectory(entry); }
  finally { showBusy(null); }
}
// ネイティブのフォルダー選択ダイアログは同時に1つしか開けない。
// 表示中にもう一度ボタンを押すと showDirectoryPicker が NotAllowedError
// （File picker already active）で落ちるため、進行中は要求を受け付けない。
let directoryPickerActive = false;
function setFolderButtonsBusy(busy: boolean){
  for(const id of ['openFolderBtn','heroFolderBtn']){
    const btn = document.getElementById(id) as HTMLButtonElement | null;
    if(btn) btn.disabled = busy;
  }
}
async function selectBrowserDirectory(){
  if(!window.showDirectoryPicker){
    // 通常はボタン側で振り分けるため到達しないが、安全のため一回読み込みへフォールバック。
    folderStatus.textContent = 'このブラウザは自動更新に未対応です。フォルダーを一回読み込みます。';
    document.getElementById('folderInput')!.click();
    return;
  }
  if(directoryPickerActive){
    folderStatus.textContent = 'フォルダー選択ダイアログを表示中です。そちらで選ぶか閉じてください。';
    return;
  }
  directoryPickerActive = true;
  setFolderButtonsBusy(true);
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ mode:'read' });
  } catch(error){
    const name = (error as Error).name;
    if(name === 'AbortError') return;      // 選択キャンセル
    if(name === 'NotAllowedError'){        // すでに別のダイアログが開いている等：静かに諦める
      folderStatus.textContent = 'フォルダー選択ダイアログを開けませんでした。開いているダイアログを閉じてからもう一度お試しください。';
      return;
    }
    console.error(error);
    folderStatus.textContent = `フォルダーを開けませんでした: ${(error as Error).message}`;
    return;
  } finally {
    directoryPickerActive = false;
    setFolderButtonsBusy(false);
  }
  try {
    await addBrowserDirectoryHandle(handle);
  } catch(error){
    console.error(error);
    folderStatus.textContent = `フォルダーを開けませんでした: ${(error as Error).message}`;
  }
}

// ---------- フォルダーのプレビュー選択GUI ----------
// フォルダー全体を並べず、まず各ファイルの3Dサムネイルを作り、見たいものだけを選ばせる。
// サムネイルはメインシーンに触れず、専用のオフスクリーンレンダラ(renderThumb)で1枚撮る。
const dirPicker = document.getElementById('dirPicker')!;
let dirPickerToken = 0;   // 開き直すたびに増やし、進行中のサムネ生成を打ち切る印にする
interface ThumbnailResult { url: string | null; message?: string; }
const PREVIEW_FULL_PARSE_MAX_BYTES = 12 * 1024 * 1024;      // STL以外を丸ごと読むプレビューの上限
const PREVIEW_GCODE_MAX_BYTES = 16 * 1024 * 1024;           // G-codeプレビューはテキスト解析なので別上限
const PREVIEW_STL_SAMPLE_MAX_BYTES = 180 * 1024 * 1024;     // バイナリSTLは間引きプレビューならここまで許可
const STL_THUMB_TRI_LIMIT = 24_000;                         // フォルダー選択プレビューのSTL最大三角形数
const GEOMETRY_THUMB_TRI_LIMIT = 48_000;                    // モデル一覧サムネの最大三角形数

function triangleCountOf(geometry: THREE.BufferGeometry){
  const pos = geometry.getAttribute('position');
  if(!pos) return 0;
  return Math.floor((geometry.index ? geometry.index.count : pos.count) / 3);
}
function thumbnailGeometryFrom(source: THREE.BufferGeometry, maxTris = GEOMETRY_THUMB_TRI_LIMIT){
  const pos = source.getAttribute('position');
  if(!pos) return source;
  const triCount = triangleCountOf(source);
  if(triCount <= maxTris) return source;
  const step = Math.max(1, Math.ceil(triCount / maxTris));
  const sampleCount = Math.ceil(triCount / step);
  const idx = source.index;
  const color = source.getAttribute('color');
  const normal = source.getAttribute('normal');
  const outPos = new Float32Array(sampleCount * 9);
  const outColor = color ? new Float32Array(sampleCount * 9) : null;
  const outNormal = normal ? new Float32Array(sampleCount * 9) : null;
  let po = 0, co = 0, no = 0;
  for(let tri=0; tri<triCount; tri+=step){
    for(let corner=0; corner<3; corner++){
      const src = idx ? idx.getX(tri*3 + corner) : tri*3 + corner;
      outPos[po++] = pos.getX(src); outPos[po++] = pos.getY(src); outPos[po++] = pos.getZ(src);
      if(color && outColor){
        outColor[co++] = color.getX(src); outColor[co++] = color.getY(src); outColor[co++] = color.getZ(src);
      }
      if(normal && outNormal){
        outNormal[no++] = normal.getX(src); outNormal[no++] = normal.getY(src); outNormal[no++] = normal.getZ(src);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(po === outPos.length ? outPos : outPos.slice(0, po), 3));
  if(outColor) geometry.setAttribute('color', new THREE.BufferAttribute(co === outColor.length ? outColor : outColor.slice(0, co), 3));
  if(outNormal) geometry.setAttribute('normal', new THREE.BufferAttribute(no === outNormal.length ? outNormal : outNormal.slice(0, no), 3));
  if(!outNormal) geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
function binaryStlTriangleCount(buf: ArrayBuffer){
  if(buf.byteLength < 84) return null;
  const tri = new DataView(buf, 80, 4).getUint32(0, true);
  const expected = 84 + tri * 50;
  return tri > 0 && expected === buf.byteLength ? tri : null;
}
function sampledBinaryStlGeometry(buf: ArrayBuffer, triCount: number, maxTris = STL_THUMB_TRI_LIMIT){
  const view = new DataView(buf);
  const step = Math.max(1, Math.ceil(triCount / maxTris));
  const sampleCount = Math.ceil(triCount / step);
  const pos = new Float32Array(sampleCount * 9);
  const normal = new Float32Array(sampleCount * 9);
  let po = 0, no = 0, hasNormal = false;
  for(let tri=0; tri<triCount; tri+=step){
    const base = 84 + tri * 50;
    if(base + 50 > buf.byteLength) break;
    const nx = view.getFloat32(base, true), ny = view.getFloat32(base+4, true), nz = view.getFloat32(base+8, true);
    const useNormal = Number.isFinite(nx) && Number.isFinite(ny) && Number.isFinite(nz) && (nx || ny || nz);
    const start = po;
    let ok = true;
    for(let corner=0; corner<3; corner++){
      const off = base + 12 + corner * 12;
      const x = view.getFloat32(off, true), y = view.getFloat32(off+4, true), z = view.getFloat32(off+8, true);
      if(!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)){ ok = false; break; }
      pos[po++] = x; pos[po++] = y; pos[po++] = z;
      normal[no++] = useNormal ? nx : 0; normal[no++] = useNormal ? ny : 0; normal[no++] = useNormal ? nz : 0;
    }
    if(!ok){ po = start; no = start; continue; }
    if(useNormal) hasNormal = true;
  }
  if(po === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(po === pos.length ? pos : pos.slice(0, po), 3));
  if(hasNormal) geometry.setAttribute('normal', new THREE.BufferAttribute(no === normal.length ? normal : normal.slice(0, no), 3));
  else geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}
function setThumbMessage(thumb: HTMLDivElement, message: string){
  thumb.classList.remove('loading');
  thumb.textContent = '';
  const span = document.createElement('span');
  span.className = 'dp-noimg';
  span.textContent = message;
  thumb.append(span);
}
function skipPreviewMessage(file: File, ext: string){
  if(ext === 'step' || ext === 'stp') return `STEP\nプレビュー省略`;
  if(ext === 'gcode' && file.size > PREVIEW_GCODE_MAX_BYTES) return `大きいG-code\nプレビュー省略\n${fmtBytes(file.size)}`;
  if(ext !== 'stl' && file.size > PREVIEW_FULL_PARSE_MAX_BYTES) return `大きいファイル\nプレビュー省略\n${fmtBytes(file.size)}`;
  return null;
}
function meshThumbFromGeometry(geometry: THREE.BufferGeometry): string | null {
  const thumbGeometry = thumbnailGeometryFrom(geometry);
  if(!thumbGeometry.attributes.normal) thumbGeometry.computeVertexNormals();
  thumbGeometry.computeBoundingBox();
  const hasVColor = !!geometry.attributes.color;
  const mat = new THREE.MeshStandardMaterial({ color:hasVColor?0xffffff:0x9aa6b4, vertexColors:hasVColor, metalness:0.05, roughness:0.65, side:THREE.DoubleSide });
  const mesh = new THREE.Mesh(thumbGeometry, mat);
  const url = renderThumb(mesh, thumbGeometry.boundingBox!);
  mat.dispose();
  if(thumbGeometry !== geometry) thumbGeometry.dispose();
  geometry.dispose();
  return url;
}
function gcodeThumbFromParsed(parsed: ParsedGcode): string | null {
  const { feats, bbox } = parsed;
  const cx=(bbox.min[0]+bbox.max[0])/2, cy=(bbox.min[1]+bbox.max[1])/2, mz=bbox.min[2];
  const grp = new THREE.Group();
  const disposables: Array<THREE.BufferGeometry | THREE.Material> = [];
  for(const [fname, f] of feats){
    if(!f.segs.length) continue;
    const pos = Float32Array.from(f.segs);
    for(let i=0;i<pos.length;i+=3){ pos[i]-=cx; pos[i+1]-=cy; pos[i+2]-=mz; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos,3));
    const mat = new THREE.LineBasicMaterial({ color:featureColor(fname) });
    const obj = new THREE.LineSegments(g, mat); obj.frustumCulled = false;
    grp.add(obj); disposables.push(g, mat);
  }
  if(!grp.children.length) return null;
  const box = new THREE.Box3(
    new THREE.Vector3(-(bbox.max[0]-bbox.min[0])/2, -(bbox.max[1]-bbox.min[1])/2, 0),
    new THREE.Vector3((bbox.max[0]-bbox.min[0])/2, (bbox.max[1]-bbox.min[1])/2, bbox.max[2]-bbox.min[2]));
  const url = renderThumb(grp, box);
  disposables.forEach(d=> d.dispose());
  return url;
}
// 1ファイルからプレビュー用サムネ(dataURL)を作る。gcode / スライス済み3mf / メッシュを判別。
async function makeStlFileThumbnail(file: File, token: number): Promise<ThumbnailResult> {
  if(file.size > PREVIEW_STL_SAMPLE_MAX_BYTES){
    return { url:null, message:`大きいSTL\nプレビュー省略\n${fmtBytes(file.size)}` };
  }
  const buffer = await file.arrayBuffer();
  if(token !== dirPickerToken) return { url:null };
  const triCount = binaryStlTriangleCount(buffer);
  if(triCount){
    const geometry = sampledBinaryStlGeometry(buffer, triCount);
    return geometry ? { url:meshThumbFromGeometry(geometry) } : { url:null, message:'プレビュー不可' };
  }
  if(file.size > PREVIEW_FULL_PARSE_MAX_BYTES){
    return { url:null, message:`ASCII STL\nプレビュー省略\n${fmtBytes(file.size)}` };
  }
  const geometry = await parseBuffer(buffer, file.name);
  if(token !== dirPickerToken){ geometry.dispose(); return { url:null }; }
  return { url:meshThumbFromGeometry(geometry) };
}
// URDF はフォルダー内のメッシュを集めて組み上げてから撮る。読み込み量は上限つき
// （足りない分は欠けたまま撮る）で、重いロボットでも選択画面を止めない。
async function makeUrdfThumbnail(file: File, name: string, meshes: Map<string, File>, token: number): Promise<ThumbnailResult> {
  const robot = await loadUrdf(await file.text(), {
    resolveMesh: urdfMeshResolver(meshes, parentPath(name), PREVIEW_FULL_PARSE_MAX_BYTES),
  });
  const dispose = ()=> robot.root.traverse(obj=>{
    const mesh = obj as THREE.Mesh;
    if(!mesh.isMesh) return;
    mesh.geometry.dispose();
    for(const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) mat.dispose();
  });
  if(token !== dirPickerToken){ dispose(); return { url:null }; }
  if(!robot.tri){ dispose(); return { url:null, message:'URDF\nメッシュなし' }; }
  const url = renderThumb(robot.root, new THREE.Box3().setFromObject(robot.root));
  dispose();
  return { url };
}
async function makeFileThumbnail(file: File, name: string, token: number, meshes: Map<string, File>): Promise<ThumbnailResult> {
  const ext = name.split('.').pop()!.toLowerCase();
  const skip = skipPreviewMessage(file, ext);
  if(skip) return { url:null, message:skip };
  try {
    if(ext === 'stl') return await makeStlFileThumbnail(file, token);
    if(ext === 'urdf') return await makeUrdfThumbnail(file, name, meshes, token);
    if(ext === 'gcode'){
      const text = await file.text();
      if(token !== dirPickerToken) return { url:null };
      return { url:gcodeThumbFromParsed(parseGcode(text)) };
    }
    if(ext === '3mf'){
      const buffer = await file.arrayBuffer();
      if(token !== dirPickerToken) return { url:null };
      const ex = extractGcodeFrom3mf(buffer);
      if(ex) return { url:gcodeThumbFromParsed(parseGcode(ex.text)) };
      const geometry = await parseBuffer(buffer, name);
      if(token !== dirPickerToken){ geometry.dispose(); return { url:null }; }
      return { url:meshThumbFromGeometry(geometry) };
    }
    const geometry = await parseFile(file);
    if(token !== dirPickerToken){ geometry.dispose(); return { url:null }; }
    return { url:meshThumbFromGeometry(geometry) };
  } catch(err){ console.warn('プレビュー生成に失敗', name, err); return { url:null, message:'プレビュー不可' }; }
}
function fmtBytes(bytes: number){
  if(bytes < 1024) return `${bytes} B`;
  if(bytes < 1048576) return `${(bytes/1024).toFixed(0)} KB`;
  return `${(bytes/1048576).toFixed(1)} MB`;
}
// プレビュー一覧を出し、表示モデルを選ばせる。解決値は選択パスの Set（表示）／null（キャンセル）。
async function openDirectoryPicker(handle: FileSystemDirectoryHandle, preselected?: Set<string>): Promise<Set<string> | null>{
  const token = ++dirPickerToken;
  showBusy(`フォルダーを走査中… ${handle.name}`);
  let files: DirFile[];
  try { files = await collectBrowserDirectoryFiles(handle); }
  catch(err){ showBusy(null); folderStatus.textContent = `フォルダーを開けませんでした: ${(err as Error).message}`; return null; }
  showBusy(null);
  if(token !== dirPickerToken) return null;   // 途中で別の選択が始まった
  const modelFiles = files
    .filter(item=> BROWSER_DIRECTORY_EXTENSIONS.has(item.file.name.split('.').pop()!.toLowerCase()))
    .sort((a,b)=> a.path.localeCompare(b.path));
  if(!modelFiles.length){
    notify(`「${handle.name}」に対応モデルが見つかりませんでした。`, { level:'warning', duration:6000 });
    return null;
  }
  // 選択GUIを見せている間に、STEPがあればCADエンジン(wasm)を裏で取得しておく。
  warmupOccFor(modelFiles.map(m=> m.path));
  const meshes = urdfMeshTable(files);   // urdf のプレビューはフォルダー全体からメッシュを引く
  const selected = new Set<string>(preselected ? [...preselected].filter(p=> modelFiles.some(m=>m.path===p)) : []);

  return await new Promise<Set<string> | null>((resolve)=>{
    let settled = false;
    const finish = (value: Set<string> | null)=>{
      if(settled) return; settled = true;
      dirPickerToken++;                                   // 進行中のサムネ生成を打ち切る
      window.removeEventListener('keydown', onKey);
      dirPicker.classList.remove('show'); dirPicker.textContent = '';
      resolve(value);
    };
    const onKey = (e: KeyboardEvent)=>{ if(e.key === 'Escape'){ e.preventDefault(); finish(null); } };
    window.addEventListener('keydown', onKey);

    const base = (p: string)=>{ const i=p.lastIndexOf('/'); return i<0 ? p : p.slice(i+1); };
    const okBtn = document.createElement('button');
    const countLabel = document.createElement('span');
    const updateCount = ()=>{
      countLabel.textContent = `${selected.size} 件を選択中`;
      okBtn.textContent = `表示（${selected.size}）`;
      okBtn.disabled = selected.size === 0;
    };

    // --- 一覧グリッド ---
    const grid = document.createElement('div'); grid.className = 'dp-grid';
    const cardByPath = new Map<string, { thumb: HTMLDivElement; cb: HTMLInputElement }>();
    for(const item of modelFiles){
      const ext = item.file.name.split('.').pop()!.toLowerCase();
      const card = document.createElement('label'); card.className = 'dp-card'; card.title = item.path;
      const thumb = document.createElement('div'); thumb.className = 'dp-thumb loading';
      thumb.innerHTML = '<span class="dp-spin"></span>';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.className = 'dp-check';
      cb.checked = selected.has(item.path);
      if(cb.checked) card.classList.add('sel');
      cb.onchange = ()=>{
        if(cb.checked) selected.add(item.path); else selected.delete(item.path);
        card.classList.toggle('sel', cb.checked);
        updateCount();
      };
      const nm = document.createElement('div'); nm.className = 'dp-name'; nm.textContent = base(item.path);
      const sub = document.createElement('div'); sub.className = 'dp-sub';
      sub.textContent = `${ext.toUpperCase()} · ${fmtBytes(item.file.size)}`;
      card.append(cb, thumb, nm, sub);
      grid.append(card);
      cardByPath.set(item.path, { thumb, cb });
    }

    // --- ヘッダ・ツール・フッタ ---
    const panel = document.createElement('div'); panel.className = 'dp-panel';
    const head = document.createElement('div'); head.className = 'dp-head';
    const title = document.createElement('div'); title.className = 'dp-title'; title.textContent = '表示するモデルを選択';
    const hsub = document.createElement('div'); hsub.className = 'dp-hsub';
    hsub.textContent = `${handle.name} · ${modelFiles.length} 件`; hsub.title = handle.name;
    const closeBtn = document.createElement('button'); closeBtn.className = 'dp-close'; closeBtn.textContent = '×'; closeBtn.title = 'キャンセル';
    closeBtn.onclick = ()=> finish(null);
    head.append(title, hsub, closeBtn);

    const tools = document.createElement('div'); tools.className = 'dp-tools';
    const allBtn = document.createElement('button'); allBtn.className = 'dp-tool'; allBtn.textContent = '全選択';
    const noneBtn = document.createElement('button'); noneBtn.className = 'dp-tool'; noneBtn.textContent = '全解除';
    const stopPreviewBtn = document.createElement('button'); stopPreviewBtn.className = 'dp-tool'; stopPreviewBtn.textContent = 'プレビュー停止';
    const setAll = (on: boolean)=>{
      selected.clear();
      for(const item of modelFiles){
        const ref = cardByPath.get(item.path)!;
        ref.cb.checked = on; ref.cb.closest('.dp-card')!.classList.toggle('sel', on);
        if(on) selected.add(item.path);
      }
      updateCount();
    };
    allBtn.onclick = ()=> setAll(true);
    noneBtn.onclick = ()=> setAll(false);
    stopPreviewBtn.onclick = ()=>{
      if(token !== dirPickerToken) return;
      dirPickerToken++;
      stopPreviewBtn.disabled = true;
      for(const ref of cardByPath.values()){
        if(ref.thumb.classList.contains('loading')) setThumbMessage(ref.thumb, 'プレビュー停止');
      }
    };
    const toolHint = document.createElement('span'); toolHint.className = 'dp-toolhint';
    toolHint.textContent = '大きいSTLは軽量サンプル、重い形式はプレビュー省略。';
    tools.append(allBtn, noneBtn, stopPreviewBtn, toolHint);

    const foot = document.createElement('div'); foot.className = 'dp-foot';
    countLabel.className = 'dp-count';
    const cancelBtn = document.createElement('button'); cancelBtn.className = 'dp-cancel'; cancelBtn.textContent = 'キャンセル';
    cancelBtn.onclick = ()=> finish(null);
    okBtn.className = 'dp-ok';
    okBtn.onclick = ()=> finish(new Set(selected));
    foot.append(countLabel, cancelBtn, okBtn);
    updateCount();

    panel.append(head, tools, grid, foot);
    // 背景クリック（パネル外）でキャンセル
    dirPicker.onclick = (e)=>{ if(e.target === dirPicker) finish(null); };
    dirPicker.textContent = ''; dirPicker.append(panel); dirPicker.classList.add('show');

    // サムネイルを1枚ずつ生成（順次・UIを止めない）。token が変われば打ち切る。
    // 大容量ファイルは解析コストが高いので、プレビュー生成をスキップして選択だけ可能にする。
    (async ()=>{
      for(const item of modelFiles){
        if(token !== dirPickerToken) return;
        const result = await makeFileThumbnail(item.file, item.path, token, meshes);
        if(token !== dirPickerToken) return;
        const ref = cardByPath.get(item.path);
        if(!ref) continue;
        ref.thumb.classList.remove('loading');
        if(result.url){
          const img = document.createElement('img'); img.src = result.url; img.alt = base(item.path);
          ref.thumb.textContent = ''; ref.thumb.append(img);
        } else {
          ref.thumb.textContent = ''; ref.thumb.classList.add('noimg');
          setThumbMessage(ref.thumb, result.message || 'プレビュー不可');
        }
        await nextFrame();
      }
      stopPreviewBtn.disabled = true;
    })();
  });
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

function objectPathName(root: THREE.Object3D, obj: THREE.Object3D, fallback: string){
  const names: string[] = [];
  for(let cur: THREE.Object3D | null = obj; cur && cur !== root; cur = cur.parent){
    const name = cur.name?.trim();
    if(name) names.unshift(name);
  }
  const path = names.join(' / ');
  return path || fallback;
}

// glTF/GLB を単一ジオメトリへ統合しつつ、各メッシュのマテリアル色（または頂点色）を
// 頂点カラー属性に焼き込む。glTFのbaseColorはリニア空間なのでそのまま使える。
// 同時に、後から部品単位で表示/非表示できるよう geometry group の範囲も保持する。
// STEPのアセンブリはメッシュが1万個を超えることもある（面ごとに分かれるため）。
// 中間ジオメトリ(toNonIndexed→clone→統合)を作らず、最終バッファへ1回で書き込む。
// 出力は従来実装とビット一致（position/color/normal・部品範囲すべて同一）。
function mergeColored(root: THREE.Object3D): ParsedMesh | null {
  interface MergeItem { mesh: THREE.Mesh; count: number; color: THREE.Color; name: string; }
  const items: MergeItem[] = [];
  let hasColor = false, hasN = true, total = 0;
  root.updateMatrixWorld(true);
  const fallbackColor = new THREE.Color(0.8,0.8,0.8);
  root.traverse(o=>{
    const om = o as THREE.Mesh;
    if(!om.isMesh || !om.geometry) return;
    const geometry = om.geometry;
    const position = geometry.getAttribute('position');
    if(!position) return;
    const count = geometry.index ? geometry.index.count : position.count;   // 非インデックス化後の頂点数
    if(!count) return;
    const mat = (Array.isArray(om.material) ? om.material[0] : om.material) as THREE.MeshStandardMaterial;
    if(mat && mat.color) hasColor = true;
    if(geometry.getAttribute('color')) hasColor = true;
    if(!geometry.getAttribute('normal')) hasN = false;
    items.push({
      mesh:om, count,
      color:(mat && mat.color) ? mat.color.clone() : fallbackColor.clone(),
      name:objectPathName(root, om, `部品 ${items.length + 1}`),
    });
    total += count;
  });
  if(items.length === 0) return null;
  const pos = new Float32Array(total*3), col = new Float32Array(total*3);
  const nor = hasN ? new Float32Array(total*3) : null;
  const normalMatrix = new THREE.Matrix3();
  let written = 0;
  for(const item of items){
    const geometry = item.mesh.geometry;
    const position = geometry.getAttribute('position')!;
    const normal = geometry.getAttribute('normal');
    const color = geometry.getAttribute('color');
    const index = geometry.index;
    const m = item.mesh.matrixWorld.elements;
    normalMatrix.getNormalMatrix(item.mesh.matrixWorld);
    const nm = normalMatrix.elements;
    const { r, g, b } = item.color;
    for(let i=0;i<item.count;i++){
      const src = index ? index.getX(i) : i;               // インデックスはここで展開する
      const x = position.getX(src), y = position.getY(src), z = position.getZ(src);
      const at = (written + i) * 3;
      pos[at]   = m[0]*x + m[4]*y + m[8] *z + m[12];
      pos[at+1] = m[1]*x + m[5]*y + m[9] *z + m[13];
      pos[at+2] = m[2]*x + m[6]*y + m[10]*z + m[14];
      if(nor && normal){
        const nx = normal.getX(src), ny = normal.getY(src), nz = normal.getZ(src);
        const tx = nm[0]*nx + nm[3]*ny + nm[6]*nz;
        const ty = nm[1]*nx + nm[4]*ny + nm[7]*nz;
        const tz = nm[2]*nx + nm[5]*ny + nm[8]*nz;
        const len = Math.sqrt(tx*tx + ty*ty + tz*tz) || 1;
        nor[at] = tx/len; nor[at+1] = ty/len; nor[at+2] = tz/len;
      }
      if(color){ col[at] = color.getX(src); col[at+1] = color.getY(src); col[at+2] = color.getZ(src); }
      else { col[at] = r; col[at+1] = g; col[at+2] = b; }
    }
    written += item.count;
  }
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
  if(nor) merged.setAttribute('normal', new THREE.BufferAttribute(nor,3)); else merged.computeVertexNormals();
  const partByName = new Map<string, MeshPartSpec>();
  let vertexStart = 0;
  for(const { name, count, color } of items){
    let part = partByName.get(name);
    if(!part){
      part = { name, ranges:[], tri:0, color:color.getHex() };
      partByName.set(name, part);
    }
    part.ranges.push({ start:vertexStart, count });
    part.tri += Math.floor(count / 3);
    vertexStart += count;
  }
  const parts = [...partByName.values()].filter(part=>part.tri > 0);
  return { geometry:merged, parts:parts.length > 1 ? parts : undefined };
}

// glTF/GLB: three.js GLTFLoader（色・マテリアルをネイティブ対応）。
// STEPを色付きで見たい場合は step2glb.mjs で GLB に変換してから読む。
async function loadGltf(buf: ArrayBuffer | { buffer: ArrayBuffer }){
  showBusy('glTF読み込み中…');
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buf instanceof ArrayBuffer ? buf : buf.buffer, '');
  const parsed = mergeColored(gltf.scene);
  if(!parsed) throw new Error('glTFにメッシュがありません');
  return parsed;
}

// STEP: フル版OCCT (opencascade.js) をブラウザ内で動かし、面ごと色まで解決して
// 色付き glTF をメモリ上に生成 → GLTFLoader で読む。occt-import-js は面色を読めず
// ほぼ単色になるため、色を出すにはフルOCCTが要る（詳細は README / step2glb.mjs）。
// 変換の実処理は step-occ.ts、ワーカー実行とキャッシュは step-loader.ts。
const isStepName = (name: string)=>{
  const ext = name.split('.').pop()!.toLowerCase();
  return ext === 'step' || ext === 'stp';
};
// STEPを読むと分かった時点でwasm取得とワーカー起動を先行させる（初回のみ ~13MB）。
// ページを開いた瞬間には落とさない：STL/G-codeだけの利用者に13MBを負担させないため、
// 「フォルダーにSTEPがあった」「STEPを読み込もうとした」時点から裏で取り始める。
function warmupOccFor(names: Iterable<string>){
  for(const name of names){
    if(!isStepName(name)) continue;
    warmupStepEngine();
    return;
  }
}
// 表示待ちのSTEPを先に変換し始める（1件あたりの時間は変わらないが、複数なら並行分だけ短縮）。
function prestartSteps(files: File[]){
  const steps = files.filter(file=> isStepName(file.name));
  if(steps.length) void prestartStepFiles(steps);
}
function stepBusyText(name: string, p: StepProgress){
  switch(p.phase){
    case 'wasm':     return `CADエンジン準備中（初回のみwasm取得 ~13MB）… ${name}`;
    case 'read':     return `STEP読み取り中… ${name}`;
    case 'transfer': return p.total
      ? `STEP形状を構築中 ${p.done ?? 0}/${p.total}… ${name}`
      : `STEP形状を構築中（重いモデルは時間がかかります）… ${name}`;
    case 'mesh':     return `曲面をメッシュ化中 ${p.done ?? 0}/${p.total ?? 0}… ${name}`;
    case 'glb':      return `色付きデータを生成中… ${name}`;
    case 'cache':    return `変換済みデータを再利用… ${name}`;
  }
}
// 二段表示：重いアセンブリは、転送できた部品だけの「途中経過」を先に出し、
// 全部品が揃った時点で本番モデルへ差し替える。品質(0.1mm/0.5rad)は途中経過も本番も同じで、
// 違いは「まだ全部品が出ていない」だけ。単体パーツ(root=1)のSTEPでは途中経過は出ない。
async function loadStep(buf: ArrayBuffer, name: string, allowPreview: boolean){
  let previewModel: Model | null = null;
  let previewBusy = false;      // 前の途中経過を描いている最中は次を捨てる（詰まらせない）
  let finished = false;

  const dropPreview = ()=>{
    if(!previewModel) return null;
    const state = captureModelState(previewModel);
    state.fromPreview = true;
    removeModel(previewModel);
    previewModel = null;
    return state;
  };
  const showPreview = async (glb: ArrayBuffer, info: StepPreviewInfo)=>{
    if(finished || previewBusy) return;
    previewBusy = true;
    try {
      const gltf = await new GLTFLoader().parseAsync(glb, '');
      if(finished) return;
      // 途中経過は部品リストを作らない（1万部品の一覧を何度も組み直すと重いため）
      const parsed = mergeColored(gltf.scene);
      if(!parsed || finished) return;
      const previous = dropPreview();
      previewModel = addModel(`${name}（読み込み中 ${info.done}/${info.total}）`, parsed.geometry, { previous, quiet:true });
    } catch(error){
      console.warn('途中経過の表示に失敗（本番の読み込みは継続）', error);
    } finally {
      previewBusy = false;
    }
  };

  let glb: ArrayBuffer;
  try {
    // 変換はワーカーで走るので、この間もスピナー・進捗・他モデルの操作が動き続ける。
    glb = await stepToGlbCached(buf, p=> showBusy(stepBusyText(name, p)), allowPreview ? showPreview : undefined);
  } catch(error){
    finished = true;
    dropPreview();
    throw error;
  }
  finished = true;
  showBusy(`色を反映中… ${name}`);
  await nextFrame();
  const gltf = await new GLTFLoader().parseAsync(glb, '');
  const parsed = mergeColored(gltf.scene);
  const previous = dropPreview();
  if(!parsed) throw new Error('STEPからメッシュを取得できませんでした');
  return { ...parsed, previous };
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
  thumbCam!.position.copy(c).add(v.multiplyScalar(d)); thumbCam!.lookAt(c);
  // 大きなモデルでも深度精度が落ちないよう、錐台を対象の大きさに合わせる（本体の updateCameraClip と同趣旨）
  thumbCam!.near = Math.max(d/200, 0.01); thumbCam!.far = d + r*2;
  thumbCam!.updateProjectionMatrix();
  thumbRenderer!.render(thumbScene!, thumbCam!);
  const url = thumbRenderer!.domElement.toDataURL('image/png');
  thumbScene!.remove(obj);
  return url;
}
function makeThumbnail(m: Model){
  try {
    if(m.isRobot){
      const clone = m.robot!.root.clone(true);
      const box = new THREE.Box3().setFromObject(clone);
      const url = renderThumb(clone, box);
      return url;
    }
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
    const thumbGeometry = thumbnailGeometryFrom(m.geometry);
    // 法線が無いのはマージ済みジオメトリ。computeVertexNormals すると thumbnailGeometryFrom が
    // 原本をそのまま返した場合に本体を滑らか法線で汚すので、フラットシェーディングで描く。
    const flat = !thumbGeometry.attributes.normal;
    thumbGeometry.computeBoundingBox();
    const mat = new THREE.MeshStandardMaterial({ color:hasVColor?0xffffff:m.color, vertexColors:hasVColor, metalness:0.05, roughness:0.65, side:THREE.DoubleSide, flatShading:flat });
    const mesh = new THREE.Mesh(thumbGeometry, mat);
    const url = renderThumb(mesh, thumbGeometry.boundingBox!);
    if(thumbGeometry !== m.geometry) thumbGeometry.dispose();
    mat.dispose();
    return url;
  } catch(e){ console.warn('サムネイル生成に失敗', e); return null; }
}

function createNormalMaterial(){
  return new THREE.MeshNormalMaterial({ side:THREE.DoubleSide });
}
function createBackfaceMaterial(){
  return new THREE.MeshBasicMaterial({ color:0xff3b30, side:THREE.BackSide });
}

// ---------- 無劣化の軽量化（頂点マージ） ----------
// 三角形は1枚も減らさない。STL等は三角形ごとに頂点を重複して持つため、共有頂点を統合すると
// 頂点バッファとGPUメモリが数分の一になる。見た目・寸法・体積・レイキャスト結果は不変。
const LITE_MIN_TRI = 20000;   // これ未満は最適化しても体感差が無く、走査コストだけ増える

// 三角形の3頂点が同一法線を持つ（＝フラットシェーディング相当）か。
// 滑らかな法線を持つモデル（STEP/glTF）は統合すると陰影が変わるため触らない。
function hasFlatNormals(g: THREE.BufferGeometry){
  const n = g.attributes.normal;
  if(!n) return true;   // 法線が無ければ後段の computeVertexNormals が面法線を作るので同じこと
  for(let i=0;i<n.count;i+=3){
    const x=n.getX(i), y=n.getY(i), z=n.getZ(i);
    for(let k=1;k<3;k++){
      if(n.getX(i+k)!==x || n.getY(i+k)!==y || n.getZ(i+k)!==z) return false;
    }
  }
  return true;
}
// 座標が float32 のビット列として完全一致する頂点だけを統合する。
// three の mergeVertices は tolerance で座標を丸めるため頂点がわずかに動く（既定 1e-4）。
// 検証用途では1ビットも動かしたくないので、ここは自前で厳密一致のみを扱う。
// 統合できなければ null。
function mergeVerticesExact(g: THREE.BufferGeometry): THREE.BufferGeometry | null {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const src = pos.array;
  const n = pos.count;
  if(!(src instanceof Float32Array) || pos.itemSize !== 3 || src.length !== n*3) return null;

  const bits = new Uint32Array(src.buffer, src.byteOffset, n*3);
  const outBits = new Uint32Array(n*3);
  const index = new Uint32Array(n);
  // ビット列の32bitハッシュでバケットに分け、候補だけを厳密比較する（文字列キーだと巨大メッシュで破綻する）
  const buckets = new Map<number, number[]>();
  let unique = 0;
  for(let i=0;i<n;i++){
    const b0 = bits[i*3], b1 = bits[i*3+1], b2 = bits[i*3+2];
    const h = (b0 ^ Math.imul(b1, 0x9e3779b1) ^ Math.imul(b2, 0x85ebca6b)) | 0;
    let bucket = buckets.get(h);
    let id = -1;
    if(bucket){
      for(const cand of bucket){
        if(outBits[cand*3]===b0 && outBits[cand*3+1]===b1 && outBits[cand*3+2]===b2){ id = cand; break; }
      }
    } else {
      bucket = []; buckets.set(h, bucket);
    }
    if(id < 0){
      id = unique++;
      outBits[id*3]=b0; outBits[id*3+1]=b1; outBits[id*3+2]=b2;
      bucket.push(id);
    }
    index[i] = id;
  }
  if(unique >= n) return null;   // 共有頂点が無い（統合しても無意味）

  const merged = new THREE.BufferGeometry();
  const outPos = new Float32Array(outBits.buffer, 0, unique*3);
  merged.setAttribute('position', new THREE.BufferAttribute(outPos.slice(), 3));
  merged.setIndex(new THREE.BufferAttribute(unique > 65535 ? index : new Uint16Array(index), 1));
  return merged;
}

interface OptimizeResult { geometry: THREE.BufferGeometry; flat: boolean; before: number; after: number; }
function optimizeGeometry(g: THREE.BufferGeometry, hasParts: boolean): OptimizeResult {
  const before = g.attributes.position.count;
  const skip: OptimizeResult = { geometry:g, flat:false, before, after:before };
  if(!lite) return skip;
  if(before < LITE_MIN_TRI*3) return skip;
  if(g.index) return skip;                 // 既にインデックス化済み
  if(hasParts) return skip;                // 部品ごとの描画レンジが頂点番号に依存するため崩せない
  if(g.attributes.color) return skip;      // 頂点カラーは統合キーに含める必要があり、利得も小さい
  if(!hasFlatNormals(g)) return skip;

  // 法線は捨てる。面法線はシェーダの微分から求める（flatShading）ので陰影は元のまま。
  const merged = mergeVerticesExact(g);
  if(!merged) return skip;
  g.dispose();
  return { geometry:merged, flat:true, before, after:merged.attributes.position.count };
}

// ---------- モデル追加 ----------
function insertModel(m: Model, previous?: PreviousState | null){
  if(Number.isInteger(previous?.index) && previous!.index >= 0) models.splice(Math.min(previous!.index, models.length), 0, m);
  else models.push(m);
}
function addModel(name: string, geometry: THREE.BufferGeometry, options: LoadOptions = {}){
  const opt = optimizeGeometry(geometry, !!options.parts?.length);
  geometry = opt.geometry;
  if(!opt.flat && !geometry.attributes.normal) geometry.computeVertexNormals();
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
    metalness:0.05, roughness:0.65, side:THREE.DoubleSide, clippingPlanes:[],
    flatShading: opt.flat,
  });
  const partSpecs = (options.parts || []).filter(part=>part.ranges.length && part.tri > 0);
  const parts: ModelPart[] | undefined = partSpecs.length > 1 ? partSpecs.map((part)=>{
    const partMat = new THREE.MeshStandardMaterial({
      color:hasVColor ? 0xffffff : (part.color ?? color), vertexColors:hasVColor,
      metalness:0.05, roughness:0.65, side:THREE.DoubleSide, clippingPlanes:[],
    });
    return {
      ...part,
      visible: options.previous?.partVisible?.get(part.name) ?? true,
      mat:partMat,
      normalMat:createNormalMaterial(),
      backfaceMat:createBackfaceMaterial(),
    };
  }) : undefined;
  if(parts){
    geometry.clearGroups();
    for(let i=0;i<parts.length;i++){
      for(const range of parts[i].ranges) geometry.addGroup(range.start, range.count, i);
    }
  }

  const mesh = new THREE.Mesh(geometry, parts ? parts.map(part=>part.mat) : mat);
  const box = new THREE.Box3Helper(geometry.boundingBox!.clone(), 0xffb347);
  const backface = new THREE.Mesh(geometry, parts ? parts.map(part=>part.backfaceMat) : backfaceRed);
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
    flat:opt.flat,
    sourceKey:options.sourceKey, sourceUrl:options.sourceUrl,
    mtime:options.mtime ?? options.previous?.mtime ?? null,
    parts,
  };
  if(options.previous) m.visible = options.previous.visible;
  m.thumb = makeThumbnail(m);
  insertModel(m, options.previous);
  if(options.previous?.selected) setSelectedModel(m.id); else updateModelDecorations();

  renderList();
  relayout();
  applyDisplay();
  // 途中経過モデルの差し替えではカメラを動かさない（見ている向き・拡大率を保つ）
  if(models.length === 1 && !options.previous?.fromPreview) fitView();
  if(!options.quiet) reportLoadStats(m, opt);
  return m;
}

// 重いモデルを読み込んだときだけ、規模と軽量化の効きを通知する（軽いモデルでは邪魔なので出さない）。
function reportLoadStats(m: Model, opt: OptimizeResult){
  if(m.tri < LITE_MIN_TRI) return;
  const lines = [m.name, `三角形 ${m.tri.toLocaleString()} / 頂点 ${m.vert.toLocaleString()}`];
  if(opt.flat){
    const cut = Math.round((1 - opt.after/opt.before) * 100);
    lines.push(`重複頂点を統合して頂点数 -${cut}%（三角形は減らしていません）`);
  }
  const sec = loadElapsedSec();
  if(sec !== null) lines.push(`読み込み ${sec.toFixed(1)} 秒`);
  notify(lines.join('\n'), { level:'info', duration:7000 });
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
  if(m.isRobot){
    m.robot!.root.traverse(o=>{
      const mesh = o as THREE.Mesh;
      if(mesh.isMesh){ mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    });
  } else if(m.isGcode){
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
    if(m.parts){
      for(const part of m.parts){
        part.mat.dispose();
        part.normalMat.dispose();
        part.backfaceMat.dispose();
      }
    }
    if(m.wire){ m.wire.geometry.dispose(); (m.wire.material as THREE.Material).dispose(); }
    if(m.edges){ m.edges.geometry.dispose(); (m.edges.material as THREE.Material).dispose(); }
  }
  models.splice(i,1);
  if(m.id===selectedModelId) setSelectedModel(null);
  renderList(); relayout(); applyDisplay();
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
  // スライス済み(gcode入り)3mfは小さい。大容量メッシュ3mfをここで一括展開すると
  // 展開後が巨大でタブがOOMするため、閾値超は gcode 抽出を行わずメッシュ解析へ委ねる。
  if(buf.byteLength > LARGE_3MF_COMPRESSED) return null;
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

// URDF を「関節で動くモデル」として登録する。
// ⚠ addModel() は形を原点中心・底面 z=0 に正規化するが、ロボットは**リンクの
//   相対位置が意味を持つ**ので正規化してはいけない。gcode と同じく別経路にする。
function addRobot(name: string, robot: UrdfRobot, options: LoadOptions = {}){
  const group = new THREE.Group();
  group.add(robot.root);
  robot.root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(robot.root);
  const size = new THREE.Vector3(); bb.getSize(size);
  // 底面 z=0・XY 中心へ寄せる（配置は relayout が行う）
  const c = new THREE.Vector3(); bb.getCenter(c);
  robot.root.position.set(-c.x, -c.y, -bb.min.z);
  scene.add(group);

  const geometry = new THREE.BufferGeometry();
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(-size.x/2,-size.y/2,0), new THREE.Vector3(size.x/2,size.y/2,size.z));
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  const selectionBox = new THREE.Box3Helper(geometry.boundingBox.clone(), 0x4f9cff); selectionBox.visible=false;
  const color = options.previous?.color ?? PALETTE[colorCursor++ % PALETTE.length];
  const label = createModelLabel(name, size, color);
  group.add(selectionBox, label);

  const m: Model = {
    id:options.previous?.id ?? ++modelIdCursor,
    name, group, geometry, isRobot:true, robot, visible:true, size, selectionBox, label,
    color, tri:Math.round(robot.tri), vert:0, vol:0,
    sourceKey:options.sourceKey, sourceUrl:options.sourceUrl,
    mtime:options.mtime ?? options.previous?.mtime ?? null,
  };
  if(options.previous) m.visible = options.previous.visible;
  m.thumb = makeThumbnail(m);
  insertModel(m, options.previous);
  if(options.previous?.selected) setSelectedModel(m.id); else updateModelDecorations();
  renderList(); relayout(); applyDisplay();
  if(models.length === 1) fitView();
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
    mtime:options.mtime ?? options.previous?.mtime ?? null,
  };
  if(options.previous) m.visible = options.previous.visible;
  m.thumb = makeThumbnail(m);
  insertModel(m, options.previous);
  if(options.previous?.selected) setSelectedModel(m.id); else updateModelDecorations();
  activeGcode = m;
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
function meshAt(){ return models.find(x=> !x.isGcode && !x.isRobot && x.visible); }
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
      setBasePos(m, x + m.size.x/2, 0, zOf(m));
      x += m.size.x + gap;
    }
  } else if(state.layout === 'grid'){
    const columns = Math.ceil(Math.sqrt(models.length));
    const rows = Math.ceil(models.length / columns);
    const cellX = Math.max(...models.map(m=>m.size.x)) + gap;
    const cellY = Math.max(...models.map(m=>m.size.y)) + gap;
    models.forEach((m, index)=>{
      const col = index % columns, row = Math.floor(index / columns);
      setBasePos(m, (col-(columns-1)/2)*cellX, ((rows-1)/2-row)*cellY, zOf(m));
    });
  } else {
    for(const m of models) setBasePos(m, 0, 0, zOf(m));
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
// 更新日時（epoch ms）を「YYYY-MM-DD HH:MM」へ。無ければ null。
function fmtMtime(ms: number | null | undefined){
  if(!ms) return null;
  const d = new Date(ms); const p = (n: number)=> String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function renderList(){
  syncEmptyState();
  // 関節パネル（URDF を読んだときだけ出す）
  const robots = models.filter(m=> m.isRobot);
  document.getElementById('jointGroup')!.style.display = robots.length ? '' : 'none';
  robotCards.set(robots.map(m=>({
    id:m.id, name:m.name,
    joints:m.robot!.joints.filter(j=> j.type !== 'fixed').map(j=>({
      name:j.name, type:j.type, lower:j.lower, upper:j.upper, value:j.value,
      unit: (j.type === 'prismatic' ? 'mm' : 'deg') as 'mm' | 'deg',
    })),
  })));
  document.getElementById('mcount')!.textContent = models.length ? `(${models.length})` : '';
  // 名前ラベルは2個以上のときだけ意味を持つので、トグル行も1個以下では隠す。
  document.getElementById('rowLabels')!.style.display = models.length >= 2 ? '' : 'none';
  const f = (n: number)=> n.toLocaleString('en-US');
  modelCards.set(models.map((m)=>{
    const hex = '#'+m.color.toString(16).padStart(6,'0');
    const md = fmtMtime(m.mtime);
    const mtimeDetail = md ? [{ label:'更新', value:md, wide:true }] : [];
    if(m.isGcode){
      return {
        id:m.id, name:m.name, isGcode:true, color:hex, visible:m.visible, thumb:m.thumb||null, opacity:m.opacity ?? 1,
        details:[
          { label:'レイヤー', value:String(m.nLayers) }, { label:'時間', value:m.header?.printTime||'—' },
          { label:'X', value:m.size.x.toFixed(1) }, { label:'Y', value:m.size.y.toFixed(1) },
          { label:'Z', value:m.size.z.toFixed(1) }, { label:'重量', value:m.header?.filWeight?m.header.filWeight.toFixed(1)+'g':'—' },
          ...mtimeDetail,
        ],
      };
    }
    if(m.isRobot){
      return {
        id:m.id, name:m.name, isGcode:false, color:hex, visible:m.visible, thumb:m.thumb||null,
        opacity:m.opacity ?? 1,
        details:[
          { label:'関節', value:String(m.robot!.joints.filter(j=>j.type!=='fixed').length) },
          { label:'リンク', value:String(m.robot!.links.size) },
          { label:'三角形', value:f(m.tri) },
          { label:'X', value:m.size.x.toFixed(1) }, { label:'Y', value:m.size.y.toFixed(1) },
          { label:'Z', value:m.size.z.toFixed(1) },
          ...mtimeDetail,
        ],
      };
    }
    const parts = m.parts?.map((part, index)=>({
      index, name:part.name, visible:part.visible, tri:part.tri,
    }));
    const partDetail = parts?.length ? [{ label:'部品', value:`${parts.filter(part=>part.visible).length}/${parts.length}` }] : [];
    return {
      id:m.id, name:m.name, isGcode:false, color:hex, visible:m.visible, thumb:m.thumb||null, opacity:m.opacity ?? 1,
      parts,
      details:[
        { label:'三角形', value:f(m.tri) }, { label:'頂点', value:f(m.vert) },
        { label:'X', value:m.size.x.toFixed(1) }, { label:'Y', value:m.size.y.toFixed(1) },
        { label:'Z', value:m.size.z.toFixed(1) }, { label:'体積', value:(m.vol/1000).toFixed(1)+'cm³' },
        ...partDetail,
        ...mtimeDetail,
      ],
    };
  }));
}

window.addEventListener('viewer:joint-action', (event)=>{
  const { id, action, name, value } = (event as CustomEvent).detail || {};
  const m = models.find(x=> x.id === id);
  if(!m || !m.isRobot) return;
  if(action === 'set-value'){
    const j = m.robot!.joints.find(x=> x.name === name);
    if(j) setJoint(j, Number(value));
  } else if(action === 'reset'){
    for(const j of m.robot!.joints) setJoint(j, 0);
  }
  m.robot!.root.updateMatrixWorld(true);
  renderList();
});

window.addEventListener('viewer:model-action', (event)=>{
  const { id, action, value } = (event as CustomEvent).detail || {};
  const m = models.find(model=>model.id===id);
  if(!m) return;
  if(action==='select'){ setSelectedModel(m.id); return; }
  if(action==='activate' && m.isGcode){ setSelectedModel(m.id); activeGcode = m; buildGcodePanel(m); return; }
  if(action==='cycle-color' && !m.isGcode){
    m.color = PALETTE[(PALETTE.indexOf(m.color)+1) % PALETTE.length];
    // インポート色（頂点カラー）を持つモデルは、ユーザーが明示的に色を選んだら単色に切替える。
    if(m.parts){
      for(const part of m.parts){
        if(part.mat.vertexColors){ part.mat.vertexColors=false; part.mat.needsUpdate=true; }
        part.mat.color.set(m.color);
      }
    }
    if(m.mat!.vertexColors){ m.mat!.vertexColors=false; m.mat!.needsUpdate=true; }
    m.mat!.color.set(m.color); refreshModelLabel(m); setSelectedModel(m.id); renderList(); return;
  }
  if(action==='set-visible'){
    m.visible = !!value; setSelectedModel(m.id); applyDisplay(); renderList(); return;
  }
  if(action==='set-opacity' && !m.isGcode){
    m.opacity = typeof value==='number' ? value : 1;
    // ストアの値はユーザーがドラッグ中の値と一致するので、再描画してもスライダーは飛ばない（％表示だけ追従）
    applyDisplay(); renderList(); return;
  }
  if(action==='set-part-visible' && !m.isGcode && m.parts && typeof value === 'object' && value){
    const { partIndex, visible } = value as { partIndex: number; visible: boolean };
    const part = m.parts[partIndex];
    if(part){ part.visible = !!visible; setSelectedModel(m.id); applyDisplay(); renderList(); }
    return;
  }
  if(action==='set-all-parts-visible' && !m.isGcode && m.parts){
    for(const part of m.parts) part.visible = !!value;
    setSelectedModel(m.id); applyDisplay(); renderList(); return;
  }
  if(action==='remove') removeModel(m);
});

// ---------- 表示切替 ----------
function setMaterialCommon(mat: THREE.Material, planes: THREE.Plane[], side?: THREE.Side){
  mat.clippingPlanes = planes;
  if(side !== undefined) mat.side = side;
}
function syncPartMaterialState(m: Model, planes: THREE.Plane[], side: THREE.Side, opacity: number){
  if(!m.parts) return;
  const transp = opacity < 1;
  for(const part of m.parts){
    part.mat.visible = part.visible;
    part.normalMat.visible = part.visible;
    part.backfaceMat.visible = part.visible;
    part.mat.clippingPlanes = planes;
    part.normalMat.clippingPlanes = planes;
    part.backfaceMat.clippingPlanes = planes;
    part.mat.side = side;
    part.normalMat.side = side;
    part.mat.transparent = transp;
    part.mat.opacity = opacity;
    part.mat.depthWrite = !transp;
  }
}
function applyDisplay(){
  const planes = state.clip ? [clipPlane] : [];
  normalMat.clippingPlanes = planes; flatNormalMat.clippingPlanes = planes; backfaceRed.clippingPlanes = planes;
  const hasGcode = models.some(m=> m.isGcode);
  for(const m of models){
    m.group.visible = m.visible;
    if(m.isRobot){
      // ⚠ ロボットはリンクごとにマテリアルが違う。クリップ面だけ配り直す。
      m.robot!.root.traverse(o=>{
        const mesh = o as THREE.Mesh;
        if(mesh.isMesh) (mesh.material as THREE.Material & { clippingPlanes: THREE.Plane[] }).clippingPlanes = planes;
      });
      continue;
    }
    if(m.isGcode){
      for(const lo of m.lineObjs!){ lo.obj.visible = m.featVisible!.get(lo.feature)!; lo.mat.clippingPlanes = planes; }
      if(m.travelObj){ m.travelObj.visible = gcShowTravel; (m.travelObj.material as THREE.Material).clippingPlanes = planes; }
      applyGcodeLayer(m);
      continue;
    }
    // gcodeがある時にゴースト指定なら、メッシュを薄く重ねてオーバーレイ比較
    const ghost = gcGhost && hasGcode;
    m.mesh!.visible = state.solid || state.normal;
    m.mesh!.material = m.parts ? m.parts.map(part=> state.normal ? part.normalMat : part.mat) : (state.normal ? (m.flat ? flatNormalMat : normalMat) : m.mat!);
    m.mat!.clippingPlanes = planes;
    // 裏面警告ON時は本体を表面のみ描画(FrontSide)にして、重ねた赤BackSideメッシュが
    // 穴や法線反転で裏面が見える箇所だけを赤く覗かせる。DoubleSideのままだと本体が
    // 裏面も通常色で描いてしまい赤と深度衝突して出ない。
    const solidSide = state.backface ? THREE.FrontSide : THREE.DoubleSide;
    if(Array.isArray(m.mesh!.material)){
      for(const mat of m.mesh!.material) setMaterialCommon(mat, planes, solidSide);
    } else {
      setMaterialCommon(m.mesh!.material as THREE.Material, planes, solidSide);
    }
    // 全体設定（ゴースト/半透明）とモデルごとの不透明度の、より透明な方を採用
    const ghostOp = ghost ? 0.18 : (state.opacity ? 0.45 : 1.0);
    const op = Math.min(ghostOp, m.opacity ?? 1);
    const transp = op < 1;
    m.mat!.transparent = transp; m.mat!.opacity = op; m.mat!.depthWrite = !transp;
    syncPartMaterialState(m, planes, solidSide, op);
    if(state.wire) ensureWire(m);
    if(state.edges) ensureEdges(m);
    const hasHiddenParts = !!m.parts?.some(part=>!part.visible);
    if(m.wire)  m.wire.visible  = state.wire && !hasHiddenParts;
    if(m.edges) m.edges.visible = state.edges && !hasHiddenParts;
    m.backface!.material = m.parts ? m.parts.map(part=>part.backfaceMat) : backfaceRed;
    m.backface!.visible = state.backface;
    m.box!.visible = state.box;
  }
  updateModelDecorations();
  // フォルダー監視の自動更新などDOMイベントを伴わない変更でも描き直させる。
  invalidate();
}

const bind = (id: string, key2: StateBoolKey, after?: ()=>void)=> document.getElementById(id)!.addEventListener('change', e=>{
  state[key2] = (e.target as HTMLInputElement).checked; applyDisplay(); if(after) after();
});
// 軽量表示：頂点マージは読み込み時に効くため、OFF→ON の切替は次に読み込むモデルから反映される。
// 解像度の追従はその場で切り替わる。
const cLite = document.getElementById('cLite') as HTMLInputElement;
cLite.addEventListener('change', ()=>{ lite = cLite.checked; appliedDpr = 0; applyPixelRatio(); invalidate(); });

const cStats = document.getElementById('cStats') as HTMLInputElement;
cStats.addEventListener('change', ()=>{
  showPerf = cStats.checked;
  perfEl.classList.toggle('show', showPerf);
  renderedFrames = 0; perfLastT = performance.now();
  invalidate();
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
    else if(m.isRobot) candidates.push(m.group);
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
  const d = r / Math.tan(THREE.MathUtils.degToRad(PERSP_FOV/2)) * 1.3;
  const dirs: Record<string, number[]> = { iso:[1,-1,0.8], front:[0,-1,0], top:[0,0.0001,1], right:[1,0,0], fit:[1,-1,0.8] };
  const v = new THREE.Vector3(...((dirs[kind]||dirs.iso) as [number, number, number])).normalize();
  camera.position.copy(c).add(v.multiplyScalar(d));
  controls.target.copy(c);
  if(orthoView){   // 距離 d で半径 r*1.3 を収める枠に合わせ、ズームは等倍へ戻す
    orthoHalfH = Math.tan(THREE.MathUtils.degToRad(PERSP_FOV/2)) * d;
    orthoCamera.zoom = 1; applyOrthoFrustum();
  }
  controls.update();
}
function fitView(){ setView('iso'); }

// 平行投影カメラの錐台を orthoHalfH とアスペクト比から組み直す（ズームは camera.zoom が担当）。
function applyOrthoFrustum(){
  const aspect = (viewEl.clientWidth || 1) / (viewEl.clientHeight || 1);
  orthoCamera.top = orthoHalfH; orthoCamera.bottom = -orthoHalfH;
  orthoCamera.left = -orthoHalfH * aspect; orthoCamera.right = orthoHalfH * aspect;
  orthoCamera.updateProjectionMatrix();
}
// 透視⇔平行を切り替える。位置・注視点・見かけの大きさを保ったまま入れ替える。
function setProjection(toOrtho: boolean){
  if(toOrtho === orthoView) return;
  const target = controls.target;
  const dir = new THREE.Vector3().subVectors(camera.position, target);
  const dist = dir.length() || 1; dir.normalize();
  if(toOrtho){
    // 現在の透視での見かけの大きさ（距離 dist でのビュー半幅）に枠を合わせる
    orthoHalfH = Math.tan(THREE.MathUtils.degToRad(PERSP_FOV/2)) * dist;
    orthoCamera.position.copy(camera.position);
    orthoCamera.zoom = 1; applyOrthoFrustum();
    camera = orthoCamera;
  } else {
    // 平行での実効半幅（orthoHalfH / zoom）と同じ見かけになる距離へ透視カメラを置く
    const effHalfH = orthoHalfH / orthoCamera.zoom;
    const newDist = effHalfH / Math.tan(THREE.MathUtils.degToRad(PERSP_FOV/2));
    perspCamera.position.copy(target).addScaledVector(dir, newDist);
    camera = perspCamera;
  }
  orthoView = toOrtho;
  controls.object = camera;
  tcontrols.camera = camera;
  controls.update();
}
(document.getElementById('cOrtho') as HTMLInputElement).addEventListener('change', e=>
  setProjection((e.target as HTMLInputElement).checked));

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
  for(const m of models){ if(!m.visible) continue; objs.push((m.isGcode || m.isRobot) ? m.group : m.mesh!); }
  const hits = _recenterRay.intersectObjects(objs, true);
  if(!hits.length) return;
  // カメラ位置は保ったまま target だけ移動 → その点を中心に回り込める
  controls.target.copy(hits[0].point);
  controls.update();
});

// ---------- ループ ----------
// ---------- 描画スケジューリング ----------
// オンデマンド描画：変化があったフレームだけ描く。静止中はGPUを止められるので、重いモデルでも
// 発熱・電力を抑えられる。見た目は一切変わらないため軽量表示のON/OFFに関係なく常時有効。
function invalidate(frames = 2){ renderRequests = Math.max(renderRequests, frames); }

// 視点操作中だけ描画解像度を落とす。手を離した瞬間にフル解像度で描き直すので、
// 静止して検証している間は常に最高品質。
const MAX_DPR = 2;
let interacting = false;
let appliedDpr = 0;
function targetDpr(){
  const full = Math.min(window.devicePixelRatio || 1, MAX_DPR);
  return (lite && interacting) ? Math.max(1, full * 0.6) : full;
}
function applyPixelRatio(){
  const dpr = targetDpr();
  if(Math.abs(dpr - appliedDpr) < 0.01) return;
  appliedDpr = dpr;
  renderer.setPixelRatio(dpr);
  renderer.setSize(viewEl.clientWidth, viewEl.clientHeight);
}
function resize(){
  const w = viewEl.clientWidth, h = viewEl.clientHeight;
  renderer.setSize(w,h);
  perspCamera.aspect = w/h; perspCamera.updateProjectionMatrix();
  applyOrthoFrustum();   // 平行投影の左右枠もアスペクト比に追従
  invalidate();
}
window.addEventListener('resize', resize); applyPixelRatio(); resize();
// パネルの表示/非表示（空状態の切替）でも #view の実寸が変わるため、要素サイズを直接監視する。
new ResizeObserver(resize).observe(viewEl);

controls.addEventListener('change', ()=> invalidate());
controls.addEventListener('start', ()=>{ interacting = true; invalidate(); });
controls.addEventListener('end',   ()=>{ interacting = false; invalidate(); });
tcontrols.addEventListener('change', ()=> invalidate());
// パネル操作・クリック選択・キー操作など、個別の invalidate 漏れを拾う保険。
// pointermove は含めない（マウスを動かすだけで描画が走り、静止時の省電力が消えるため）。
for(const ev of ['pointerdown','pointerup','wheel','keydown','input','change','click']){
  document.addEventListener(ev, ()=> invalidate(2), { capture:true, passive:true });
}

// ---------- パフォーマンス表示 ----------
const perfEl = document.getElementById('perf')!;
let showPerf = false;
let renderedFrames = 0, perfLastT = performance.now();
function perfTick(now: number){
  if(!showPerf || now - perfLastT < 500) return;
  const fps = renderedFrames * 1000 / (now - perfLastT);
  const idle = renderedFrames === 0;
  renderedFrames = 0; perfLastT = now;
  const info = renderer.info;
  let tri = 0, vert = 0;
  for(const m of models){ if(!m.isGcode){ tri += m.tri; vert += m.vert; } }
  perfEl.textContent = [
    idle ? '静止中（描画停止）' : `${fps.toFixed(0)} fps`,
    `描画三角形   ${info.render.triangles.toLocaleString()}`,
    `ドローコール ${info.render.calls}`,
    `メッシュ     ${tri.toLocaleString()} 三角形 / ${vert.toLocaleString()} 頂点`,
    `ピクセル比   ${appliedDpr.toFixed(2)}x`,
  ].join('\n');
}

let _lastT = performance.now();
function animate(){
  requestAnimationFrame(animate);
  const now = performance.now(), dt = Math.min((now-_lastT)/1000, 0.1); _lastT = now;
  tickPlayback(dt);
  if(gcPlaying) invalidate(1);
  if(spin){ for(const m of models) m.group.rotation.z += 0.005; invalidate(1); }
  if(controls.update()) invalidate(1);
  perfTick(now);
  if(renderRequests <= 0) return;
  renderRequests--;
  applyPixelRatio();
  updateCameraClip();
  renderer.render(scene, camera);
  renderedFrames++;
}
// 同一オリジンで公開済みのファイルは ?model=foo.stl / ?model=robot.urdf /
// ?gcode=plate.gcode（各複数可）で自動ロードできる。
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
