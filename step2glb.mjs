#!/usr/bin/env node
// STEP/IGES を「色付き」glTF(.glb) に変換する。
//
// なぜこれが要るか:
//   ブラウザ内の occt-import-js は、このリポジトリで扱う KiCad/CadQuery 由来の STEP の
//   面ごと色(OVER_RIDING_STYLED_ITEM → ADVANCED_FACE)を読めず、ほぼ単色になる。
//   フル版 OCCT(opencascade.js) なら XCAF 経由で全色を解決でき、RWGltf が色付き glTF を吐く。
//   生成した .glb を 3D検証ビューア(index.html)にドロップすれば色付きで表示できる。
//
// 使い方:
//   cd projects/viewer && npm install        # 初回のみ(opencascade.js を取得)
//   node step2glb.mjs <input.step> [output.glb]
//
// 注意: opencascade.js の wasm は数十MB。変換は CPU 処理で、大きいモデルは時間がかかる。

import initOpenCascade from 'opencascade.js/dist/node.js';
import fs from 'fs';
import path from 'path';

const input = process.argv[2];
if (!input) {
  console.error('使い方: node step2glb.mjs <input.step> [output.glb]');
  process.exit(2);
}
const output = process.argv[3] || input.replace(/\.(stp|step|igs|iges)$/i, '') + '.glb';
const log = (...a) => console.error('[step2glb]', ...a);

const oc = await initOpenCascade();
log('opencascade 初期化完了');

const data = new Uint8Array(fs.readFileSync(input));
oc.FS.writeFile('/in.step', data);
log(`読み込み: ${input} (${data.length} bytes)`);

// XCAF ドキュメント
const app = oc.XCAFApp_Application.GetApplication().get();
const doc = new oc.Handle_TDocStd_Document_1();
app.NewDocument_2(new oc.TCollection_ExtendedString_2('MDTV-XCAF', true), doc);

// 色・名前付きで STEP を読む
const reader = new oc.STEPCAFControl_Reader_1();
reader.SetColorMode(true);
reader.SetNameMode(true);
reader.SetLayerMode(true);
const status = reader.ReadFile('/in.step');
if (status !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
  log('STEP の読み込みに失敗'); process.exit(1);
}
if (!reader.Transfer_1(doc, new oc.Message_ProgressRange_1())) {
  log('XCAF への転送に失敗'); process.exit(1);
}

// glTF 出力には三角形分割が必要。葉(部品)シェイプをすべてメッシュ化する。
const main = doc.get().Main();
const shapeTool = oc.XCAFDoc_DocumentTool.ShapeTool(main).get();
const labels = new oc.TDF_LabelSequence_1();
shapeTool.GetShapes(labels);
let meshed = 0;
for (let i = 1; i <= labels.Length(); i++) {
  const lab = labels.Value(i);
  if (!oc.XCAFDoc_ShapeTool.IsSimpleShape(lab)) continue;
  const shape = new oc.TopoDS_Shape();
  if (!oc.XCAFDoc_ShapeTool.GetShape_1(lab, shape)) continue;
  // (shape, 線形たわみ, 相対, 角度たわみ rad, 並列)
  new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
  meshed++;
}
log(`メッシュ化した部品: ${meshed}`);

// glb(バイナリ glTF)で書き出し。RWGltf が XCAFPrs で色を解決して材質に焼く。
const writer = new oc.RWGltf_CafWriter(new oc.TCollection_AsciiString_2('/out.glb'), true);
// glTF は既定でメートル。STEP(mm) をそのまま mm で書き出す(入出力単位を揃えて無スケール)。
// こうしないとビューアの寸法・体積が 1/1000 になる。ChangeCoordinateSystemConverter() の
// 戻り値を直接いじっても反映されないため、設定済みコンバータを Set で渡す。
const conv = new oc.RWMesh_CoordinateSystemConverter();
conv.SetInputLengthUnit(0.001);
conv.SetOutputLengthUnit(0.001);
writer.SetCoordinateSystemConverter(conv);
const fileInfo = new oc.TColStd_IndexedDataMapOfStringString_1();
if (!writer.Perform_2(doc, fileInfo, new oc.Message_ProgressRange_1())) {
  log('glTF 書き出しに失敗'); process.exit(1);
}
const glb = oc.FS.readFile('/out.glb');
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
fs.writeFileSync(output, Buffer.from(glb));

// 何色入ったか軽く報告
try {
  const b = Buffer.from(glb);
  const jlen = b.readUInt32LE(12);
  const j = JSON.parse(b.slice(20, 20 + jlen).toString('utf8'));
  const cols = new Set((j.materials || []).map(m => {
    const f = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorFactor;
    return f ? f.slice(0, 3).map(v => v.toFixed(3)).join(',') : null;
  }).filter(Boolean));
  log(`完了: ${output} (${glb.length} bytes, メッシュ${(j.meshes||[]).length} / 色${cols.size})`);
} catch {
  log(`完了: ${output} (${glb.length} bytes)`);
}
