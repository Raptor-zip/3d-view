/**
 * `mounts.json` のフォルダーを **本番ビルド用に** `public/local/<名前>/` へ複製する。
 *
 *     npm run build   # これが自動で呼ぶ
 *     npm run mounts:sync
 *
 * 開発サーバでは `scripts/vite-mounts.ts` が同じパス (`/local/<名前>/`) を
 * 元フォルダーから直接返すので、この複製は要らない。**dist に入れるには
 * ビルド時に public にある必要がある**ので、ここでだけ複製する。
 *
 * ⚠ **URL を開発と本番で同じにするのが狙い**。どちらも
 *   `/?model=/local/nhk-tr/tr.urdf` で開ける。共有したリンクが
 *   「手元では出るのに公開版では出ない」にならない。
 *
 * ⚠ `public/local/` は**生成物**なので git では追跡しない。
 * ⚠ Node の ESM で書いてある（このリポジトリは `step2glb.mjs` と同じ流儀。
 *   tsx のような追加の依存を増やさない）。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG = resolve(HERE, '..', 'mounts.json');
const DST_ROOT = resolve(HERE, '..', 'public', 'local');

/** 表示に使う拡張子だけ運ぶ。ソース (.py) や中間物まで公開しない */
const KEEP = /\.(urdf|stl|obj|3mf|glb|gltf|step|stp|gcode|json)$/i;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function copyDir(src, dst) {
  let files = 0;
  let bytes = 0;
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === '__pycache__') continue;
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDir(from, to);
      files += sub.files;
      bytes += sub.bytes;
    } else if (KEEP.test(entry.name)) {
      cpSync(from, to);
      files += 1;
      bytes += statSync(from).size;
    }
  }
  return { files, bytes };
}

function main() {
  if (!existsSync(CONFIG)) {
    // Cloudflare の Git ビルドには開発者個人の mounts.json は存在しない。
    // リポジトリに同梱した公開用アセットを残し、クリーンビルドでも
    // /local/<name>/ が消えないようにする。
    console.log('mounts.json が無いので、同梱済み public/local/ をそのまま使う');
    return 0;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch (error) {
    console.error(`mounts.json を読めません: ${error.message}`);
    return 1;
  }

  // ローカル用の mounts.json がある場合だけ生成物を同期する。
  rmSync(DST_ROOT, { recursive: true, force: true });

  let total = 0;
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value !== 'string' || !/^[\w.-]+$/.test(name)) continue;
    const src = resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(src) || !statSync(src).isDirectory()) {
      // ⚠ **ここで落とす。** 黙って飛ばすと、公開したリンクだけが
      //   index.html にフォールバックして「開いても何も出ない」になる。
      console.error(`mounts "${name}": フォルダーがありません ${src}`);
      return 1;
    }
    const { files, bytes } = copyDir(src, join(DST_ROOT, name));
    total += bytes;
    console.log(`/local/${name}/  ${files} ファイル  ${mb(bytes)}  ← ${src}`);
  }
  if (total) console.log(`合計 ${mb(total)} → ${DST_ROOT}`);
  return 0;
}

process.exit(main());
