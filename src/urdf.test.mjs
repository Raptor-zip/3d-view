// URDF パーサの検算（ブラウザを開かずに確かめる）。
//   node src/urdf.test.mjs public/urdf/tr.urdf
//
// ⚠ ブラウザでしか動かないものを「動くはず」で置いておくと、実際に開いた
//   ときに黙って何も出ない。関節の木・軸・可動範囲・メッシュ参照だけでも
//   Node で確かめておく（DOMParser が無いので最小の XML 読みを持つ）。
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const path = process.argv[2] || 'public/urdf/tr.urdf';
const xml = readFileSync(path, 'utf8');
const base = dirname(path);

// タグを雑に拾う（属性は key="value" のみ）
const attrs = (tag) => Object.fromEntries(
  [...tag.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)].map(m => [m[1], m[2]]));
const tags = (name, src = xml) =>
  [...src.matchAll(new RegExp(`<${name}\\b([^>]*)(/>|>([\\s\\S]*?)</${name}>)`, 'g'))]
    .map(m => ({ attr: attrs(m[1]), body: m[3] || '' }));

const links = tags('link');
const joints = tags('joint');
const meshes = tags('mesh');

let bad = 0;
const say = (ok, msg) => { if (!ok) bad++; console.log(`${ok ? '  OK ' : '  NG '} ${msg}`); };

console.log(`[${path}] link ${links.length} / joint ${joints.length} / mesh 参照 ${meshes.length}`);

// 1) 木構造: child は 1 回だけ現れ、root がちょうど 1 つ
const childCount = new Map();
for (const j of joints) {
  const c = tags('child', j.body)[0]?.attr.link;
  childCount.set(c, (childCount.get(c) || 0) + 1);
}
const names = links.map(l => l.attr.name);
const roots = names.filter(n => !childCount.has(n));
say(roots.length === 1, `ルートの link は 1 つ (${roots.join(', ') || 'なし'})`);
say([...childCount.values()].every(v => v === 1), '同じ link を child にする関節は 1 つだけ');

// 2) 可動関節に axis と limit があるか
for (const j of joints) {
  const t = j.attr.type;
  if (t === 'fixed' || t === 'continuous') continue;
  const ax = tags('axis', j.body)[0];
  const lim = tags('limit', j.body)[0];
  say(!!ax, `${j.attr.name}: axis がある`);
  say(!!lim && lim.attr.lower !== undefined && lim.attr.upper !== undefined,
    `${j.attr.name}: limit lower/upper がある`);
  if (lim) {
    const lo = Number(lim.attr.lower), hi = Number(lim.attr.upper);
    say(hi > lo, `${j.attr.name}: 可動範囲が正 (${lo} .. ${hi})`);
  }
}

// 3) メッシュのファイルが実在するか
for (const m of meshes) {
  const f = (m.attr.filename || '').replace(/^package:\/\//, '');
  say(existsSync(resolve(base, f)), `メッシュがある: ${f}`);
}

console.log(bad ? `\n${bad} 件が NG` : '\nすべて OK');
process.exit(bad ? 1 : 0);
