// STEP → 色付きGLB 変換（OCCT/wasm）の実処理。
// ワーカー(step-worker.ts)とメインスレッド(フォールバック)の両方から使うため、
// DOM に触らない純粋な処理だけをここに置く。
//
// なぜフル版OCCTなのか: occt-import-js は面ごとの色(OVER_RIDING_STYLED_ITEM)を
// 読めずほぼ単色になる。色付きで見るには XCAF を持つフル版が要る（README / step2glb.mjs 参照）。
// wasm は約48MB(gzip後~13MB)で初回のみCDNから取得・以降ブラウザキャッシュ。
export const OCC_VER = '2.0.0-beta.b5ff984';
export const OCC_BASE = `https://cdn.jsdelivr.net/npm/opencascade.js@${OCC_VER}/dist/`;

// メッシュ化の品質パラメータ。表示品質そのものなので変更しない（キャッシュキーにも入れる）。
export const MESH_LINEAR_DEFLECTION = 0.1;   // mm
export const MESH_ANGULAR_DEFLECTION = 0.5;  // rad

// 'cache' は変換済みGLBをキャッシュから復元した場合（変換していない）。
export type StepPhase = 'wasm' | 'read' | 'transfer' | 'mesh' | 'glb' | 'cache';
export interface StepProgress { phase: StepPhase; done?: number; total?: number; }
export type StepProgressFn = (p: StepProgress)=> void;
// 途中経過（転送済みの部品だけを含むGLB）。done/total は root 数。
export interface StepPreviewInfo { done: number; total: number; }
export type StepPreviewFn = (glb: ArrayBuffer, info: StepPreviewInfo)=> void;

// 一段目（途中経過）を出す条件。数秒で終わるファイルに割り込んでもちらつくだけなので出さない。
// 目安として 8MB 超のSTEPは十数秒以上かかる（実測 28MB で約50秒、4〜7MB で5〜8秒）。
const PREVIEW_MIN_BYTES = 8 * 1024 * 1024;
const PREVIEW_ROOT_LIMIT = 6;           // 先出しのために個別転送する root の上限
const PREVIEW_ROOT_BUDGET_MS = 8000;    // 先出しに使ってよい時間の上限
const now = ()=> (typeof performance !== 'undefined' ? performance.now() : Date.now());

let occPromise: Promise<any> | null = null;
let occInstance: any = null;
// wasmヒープは一度膨らむと縮まないため、呼び出し側がワーカーを作り直す判断に使う。
export function occHeapBytes(): number | undefined {
  return occInstance?.HEAPU8?.byteLength;
}
export function loadOCC(): Promise<any> {
  if(occPromise) return occPromise;
  const pending = occPromise = (async ()=>{
    // CDNのESMを動的import（Viteにバンドルさせない）。wasmはlocateFileでCDNを指す。
    const mod = await import(/* @vite-ignore */ OCC_BASE + 'opencascade.full.js');
    const factory = mod.default;
    occInstance = await new factory({ locateFile: (p: string)=> p.endsWith('.wasm') ? OCC_BASE + 'opencascade.full.wasm' : p });
    return occInstance;
  })();
  // 失敗（オフライン・CDN一時障害など）は記憶しない。次の読み込みで再試行できるようにする。
  pending.catch(()=>{ if(occPromise === pending) occPromise = null; });
  return pending;
}

// ドキュメント内のまだメッシュ化していないシェイプだけをメッシュ化する。
// meshedTags に済みラベルのTagを覚えておくのが肝で、これを省いて毎回全シェイプに
// BRepMesh を掛けると（済みなら中で弾かれるとはいえ）root数×シェイプ数の走査になり、
// 実測で全体が5倍遅くなった。
function meshDocument(oc: any, doc: any, meshedTags: Set<number>, onEach?: (done: number, total: number)=> void){
  const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(doc.get().Main()).get();
  const labels = new oc.TDF_LabelSequence_1();
  shapeTool.GetShapes(labels);
  const count = labels.Length();
  const pending: number[] = [];
  for(let i=1;i<=count;i++){
    const lab = labels.Value(i);
    if(!oc.XCAFDoc_ShapeTool.IsSimpleShape(lab)) continue;
    if(meshedTags.has(lab.Tag())) continue;
    pending.push(i);
  }
  const base = meshedTags.size;                  // 進捗は「全部品のうち何個目か」で出す
  const total = base + pending.length;
  onEach?.(base, total);
  for(const i of pending){
    const lab = labels.Value(i);
    const shape = new oc.TopoDS_Shape();
    if(!oc.XCAFDoc_ShapeTool.GetShape_1(lab, shape)){ shape.delete(); continue; }
    const mesher = new oc.BRepMesh_IncrementalMesh_2(
      shape, MESH_LINEAR_DEFLECTION, false, MESH_ANGULAR_DEFLECTION, false);
    mesher.delete();   // メッシャ自体は破棄してよい（三角形分割はシェイプ側に残る）
    shape.delete();
    meshedTags.add(lab.Tag());
    onEach?.(meshedTags.size, total);
  }
  labels.delete();
  return total;
}

// 現時点のドキュメントを色付きGLBに書き出す。単位はmm維持(入出力単位を0.001で揃える)。
function writeGlb(oc: any, doc: any, path: string): ArrayBuffer | null {
  const writer = new oc.RWGltf_CafWriter(new oc.TCollection_AsciiString_2(path), true);
  const conv = new oc.RWMesh_CoordinateSystemConverter();
  conv.SetInputLengthUnit(0.001); conv.SetOutputLengthUnit(0.001);
  writer.SetCoordinateSystemConverter(conv);
  const ok = writer.Perform_2(doc, new oc.TColStd_IndexedDataMapOfStringString_1(), new oc.Message_ProgressRange_1());
  writer.delete(); conv.delete();
  if(!ok) return null;
  const glb = oc.FS.readFile(path);   // Uint8Array
  const ab = glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
  oc.FS.unlink(path);
  return ab;
}

// STEPのバイト列を色付きGLB(ArrayBuffer)へ変換する。
// 進捗は phase 単位（転送・メッシュ化は件数つき）で通知する。
// onPreview を渡すと、転送済みの部品だけを含む「途中経過GLB」を随時返す（＝二段表示）。
// 品質は最終GLBと同じ 0.1mm/0.5rad のまま。粗いメッシュではなく「まだ全部品が揃っていない」状態。
export async function stepToGlb(
  bytes: Uint8Array, onProgress?: StepProgressFn, onPreview?: StepPreviewFn,
): Promise<ArrayBuffer>{
  onProgress?.({ phase:'wasm' });
  const oc = await loadOCC();

  onProgress?.({ phase:'read' });
  oc.FS.writeFile('/in.step', bytes);
  // XCAFドキュメントへ色・名前付きで読み込む
  const app = oc.XCAFApp_Application.GetApplication().get();
  const doc = new oc.Handle_TDocStd_Document_1();
  app.NewDocument_2(new oc.TCollection_ExtendedString_2('MDTV-XCAF', true), doc);
  const reader = new oc.STEPCAFControl_Reader_1();
  reader.SetColorMode(true); reader.SetNameMode(true); reader.SetLayerMode(true);
  try {
    if(reader.ReadFile('/in.step') !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) throw new Error('STEP解析に失敗');

    const roots: number = reader.Reader().NbRootsForTransfer();
    const meshedTags = new Set<number>();

    // ---- 一段目：先頭のいくつかの root だけ個別に転送して、そこまでを先に見せる ----
    // root単位の転送は1回ごとに色・名前・レイヤの走査が入る（実測 約1秒/回）ため、
    // 全rootを個別に回すと一括より4割以上遅くなる。先頭数個だけ個別にして残りは一括で取ると、
    // 最終結果は一括のみと完全に一致したまま（三角形数・色数・bbox 一致を確認済み）、
    // 追加コストはほぼゼロで最初の部品を早く出せる。
    if(onPreview && roots > 1 && bytes.byteLength >= PREVIEW_MIN_BYTES){
      let preRoots = 0;
      const budgetUntil = now() + PREVIEW_ROOT_BUDGET_MS;
      for(let i=1;i<=Math.min(PREVIEW_ROOT_LIMIT, roots-1); i++){
        onProgress?.({ phase:'transfer', done:i-1, total:roots });
        reader.TransferOneRoot(i, doc, new oc.Message_ProgressRange_1());
        preRoots = i;
        if(now() >= budgetUntil) break;      // 先出しに時間を掛けすぎない
      }
      meshDocument(oc, doc, meshedTags);
      const partial = writeGlb(oc, doc, '/preview.glb');
      if(partial) onPreview(partial, { done:preRoots, total:roots });
    }

    // ---- 二段目：残りを一括転送（転送済みのrootは再利用されるので二重にはならない）----
    onProgress?.({ phase:'transfer' });
    reader.Transfer_1(doc, new oc.Message_ProgressRange_1());

    // glTF出力には三角形分割が要る。残りの葉(部品)シェイプをメッシュ化。
    meshDocument(oc, doc, meshedTags, (done, total)=> onProgress?.({ phase:'mesh', done, total }));

    onProgress?.({ phase:'glb' });
    const ab = writeGlb(oc, doc, '/out.glb');
    if(!ab) throw new Error('glTFの生成に失敗');
    return ab;
  } finally {
    // OCCTのwasmヒープを片付ける（大きいSTEPの連続読込でのリークを抑える）。
    // ドキュメントを閉じないと変換したシェイプが残り続け、次のファイルでヒープが膨らむ。
    reader.delete();
    try { oc.FS.unlink('/in.step'); } catch { /* 既に消えていれば無視 */ }
    try { app.Close(doc); } catch(e){ console.warn('XCAFドキュメントの解放に失敗', e); }
  }
}
