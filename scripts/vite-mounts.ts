import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

/**
 * 開発サーバに**リポジトリ外のフォルダー**を生やして、URL だけでモデルを開けるようにする。
 *
 *     mounts.json:  { "nhk-tr": "/home/you/RoboCon/NHK-K2026/cad/urdf" }
 *     → http://localhost:8000/?model=/local/nhk-tr/tr.urdf
 *
 * URDF のように**外部メッシュを相対パスで参照する**形式は、ファイル1個をドロップ
 * しても形が出ない（`meshes/*.stl` を辿れない）。フォルダーを丸ごと配信して
 * しまえば、ビューアが `?model=` から相対 URL でメッシュを取りに来られる。
 *
 * ⚠ **`public/` へコピーして済ませない。** Vite は起動時に public のファイル
 *   一覧を作って持つので、サーバを立てた**後に**増えたファイルは「public に無い」
 *   と判定され、SPA フォールバックで **index.html が 200 で**返る。STL パーサが
 *   HTML を読んで `RangeError: Invalid typed array length` のような無関係な例外で
 *   落ちる。元データを毎リクエスト読めば、CAD を出し直してもリロードで反映される。
 *
 * ⚠ **開発サーバ限定**（`apply: 'serve'`）。`npm run build` の成果物には入らない。
 *   配布したいものは `public/` に置くか、`dist/` の隣へ自分で配置する。
 */

const MOUNT_PREFIX = '/local/';

const TYPES: Record<string, string> = {
  '.urdf': 'application/xml',
  '.stl': 'model/stl',
  '.obj': 'text/plain; charset=utf-8',
  '.3mf': 'model/3mf',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.step': 'application/step',
  '.stp': 'application/step',
  '.gcode': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};

interface Mounts {
  /** 公開名 → 絶対パス（存在するディレクトリのみ） */
  dirs: Map<string, string>;
  /** mounts.json の mtime。変わったら読み直す */
  stamp: number;
}

function readMounts(configPath: string): Mounts {
  const empty: Mounts = { dirs: new Map(), stamp: 0 };
  if (!existsSync(configPath)) return empty;
  const stamp = statSync(configPath).mtimeMs;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn(`[mounts] ${configPath} を読めません: ${(error as Error).message}`);
    return { dirs: new Map(), stamp };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn('[mounts] mounts.json は { "名前": "/絶対パス" } の形にしてください');
    return { dirs: new Map(), stamp };
  }
  const dirs = new Map<string, string>();
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    // ⚠ 名前に `/` を許すと prefix の切り出しが壊れる
    if (!/^[\w.-]+$/.test(name)) {
      console.warn(`[mounts] 名前に使えない文字: ${name}（英数と . _ - のみ）`);
      continue;
    }
    const dir = resolve(value.replace(/^~(?=\/|$)/, process.env.HOME ?? '~'));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      console.warn(`[mounts] ${name}: フォルダーがありません ${dir}`);
      continue;
    }
    dirs.set(name, dir);
  }
  return { dirs, stamp };
}

export function localMounts(): Plugin {
  const HERE = dirname(fileURLToPath(import.meta.url));
  const CONFIG = resolve(HERE, '..', 'mounts.json');
  let mounts = readMounts(CONFIG);

  const refresh = (): void => {
    const stamp = existsSync(CONFIG) ? statSync(CONFIG).mtimeMs : 0;
    if (stamp !== mounts.stamp) mounts = readMounts(CONFIG);
  };

  return {
    name: 'local-mounts',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        if (!mounts.dirs.size) return;
        const addr = server.httpServer?.address();
        const port = typeof addr === 'object' && addr ? addr.port : 8000;
        const base = `http://127.0.0.1:${port}`;
        console.log('\n  外部フォルダー (mounts.json):');
        for (const [name, dir] of mounts.dirs) {
          console.log(`  ➜  /local/${name}/  →  ${dir}`);
          // そのまま貼れる URL を出す。フォルダー直下のモデルだけ拾う（浅く見る）
          for (const entry of readdirSafe(dir)) {
            if (!/\.(urdf|glb|gltf|stl|step|stp|3mf|obj)$/i.test(entry)) continue;
            console.log(`     ${base}/?model=/local/${name}/${entry}`);
          }
        }
        console.log('');
      });

      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!;
        if (!path.startsWith(MOUNT_PREFIX)) return next();
        refresh();

        const rest = decodeURIComponent(path.slice(MOUNT_PREFIX.length));
        const slash = rest.indexOf('/');
        const name = slash < 0 ? rest : rest.slice(0, slash);
        const root = mounts.dirs.get(name);
        const fail = (message: string): void => {
          // ⚠ **index.html にフォールバックさせない。** next() すると SPA
          //   フォールバックが HTML を 200 で返し、「STL のはずが HTML」という
          //   分かりにくい失敗になる。404 は 404 として返す。
          res.statusCode = 404;
          res.setHeader('content-type', 'text/plain; charset=utf-8');
          res.end(message);
        };
        if (!root) {
          const known = [...mounts.dirs.keys()].join(', ') || '（mounts.json が空）';
          return fail(`mounts: "${name}" は mounts.json にありません。あるのは: ${known}`);
        }

        // パストラバーサル止め。`..` を潰してから root の下かを確かめる
        const rel = normalize(slash < 0 ? '' : rest.slice(slash + 1));
        const file = join(root, rel);
        if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
          return fail(`mounts: ${rel || '(空)'} が ${root} にありません`);
        }

        const dot = rel.lastIndexOf('.');
        res.setHeader('content-type', (dot < 0 ? '' : TYPES[rel.slice(dot).toLowerCase()]) ?? 'application/octet-stream');
        res.setHeader('content-length', String(statSync(file).size));
        // 元データを毎回読み直す（CAD を出し直したらリロードで反映される）
        res.setHeader('cache-control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
