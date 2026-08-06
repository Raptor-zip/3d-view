// URDF（ロボット記述）を読んで、関節で動く three.js の階層を組む。
//
// ⚠ URDF は **メートル**、このビューアは **mm** で描いている。
//   ルートに scale 1000 を掛けて mm 世界へ持ち込む。直動関節の値も
//   同じ木の中にあるので一緒に拡大される（＝m 指定のまま正しく動く）。
//
// ⚠ `<origin rpy="r p y">` は**固定軸**の roll-pitch-yaw で、
//   R = Rz(y)·Ry(p)·Rx(r)。three.js の Euler では順序 'ZYX' がこれに当たる。
//   既定の 'XYZ' で入れると、rpy が 2 つ以上非ゼロの関節が静かにずれる。
import * as THREE from 'three';

export type JointType = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar';

export interface UrdfJoint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  axis: THREE.Vector3;
  lower: number;          // rad か m（fixed は 0）
  upper: number;
  value: number;          // いまの関節値
  /** 関節の運動を担うノード（origin の子） */
  motion: THREE.Object3D;
}

export interface UrdfRobot {
  name: string;
  root: THREE.Object3D;           // scale 1000 を掛けたルート
  joints: UrdfJoint[];
  links: Map<string, THREE.Object3D>;
  missing: string[];              // 見つからなかったメッシュ
  tri: number;
}

export interface UrdfLoadOptions {
  /** メッシュのファイル名（URDF に書かれた相対パス）から形状を返す */
  resolveMesh: (filename: string) => Promise<THREE.BufferGeometry | null>;
  material?: (linkName: string) => THREE.Material;
}

const num = (s: string | null | undefined, d = 0) => {
  const v = Number.parseFloat(s ?? '');
  return Number.isFinite(v) ? v : d;
};
const vec3 = (s: string | null | undefined, d = 0) => {
  const p = (s ?? '').trim().split(/\s+/);
  return new THREE.Vector3(num(p[0], d), num(p[1], d), num(p[2], d));
};

/** `<origin>` を Object3D の位置・姿勢に反映する */
function applyOrigin(node: THREE.Object3D, el: Element | null): void {
  if (!el) return;
  const xyz = vec3(el.getAttribute('xyz'));
  const rpy = vec3(el.getAttribute('rpy'));
  node.position.copy(xyz);
  // ⚠ 'ZYX' 固定。URDF の rpy は固定軸なので Rz·Ry·Rx。
  node.quaternion.setFromEuler(new THREE.Euler(rpy.x, rpy.y, rpy.z, 'ZYX'));
}

/** `<material>` の色。`<color rgba="r g b a">` が無ければ null（名前だけの参照はここでは解けない） */
function materialSpec(el: Element | null): { color: THREE.Color; opacity: number } | null {
  const rgba = el?.querySelector('color')?.getAttribute('rgba');
  if (!rgba) return null;
  const p = rgba.trim().split(/\s+/).map(v => Number.parseFloat(v));
  if (p.length < 3 || p.slice(0, 3).some(v => !Number.isFinite(v))) return null;
  // ⚠ URDF の rgba は **sRGB の 0..1**。three の作業色空間へは sRGB として渡す
  //   （setRGB の既定はリニアなので、そのまま入れると全体が白く浮く）。
  const color = new THREE.Color().setRGB(p[0], p[1], p[2], THREE.SRGBColorSpace);
  const a = Number.parseFloat(String(p[3]));
  return { color, opacity: Number.isFinite(a) ? Math.min(1, Math.max(0, a)) : 1 };
}
/** visual の material を解決する。`<material name="x"/>` だけなら robot 直下の定義を引く。 */
function visualMaterial(vis: Element, named: Map<string, { color: THREE.Color; opacity: number }>) {
  const el = vis.querySelector(':scope > material');
  if (!el) return null;
  const inline = materialSpec(el);
  if (inline) return inline;
  const ref = el.getAttribute('name');
  return ref ? named.get(ref) ?? null : null;
}

function primitive(geo: Element): THREE.BufferGeometry | null {
  const box = geo.querySelector('box');
  if (box) {
    const s = vec3(box.getAttribute('size'));
    return new THREE.BoxGeometry(s.x, s.y, s.z);
  }
  const cyl = geo.querySelector('cylinder');
  if (cyl) {
    const r = num(cyl.getAttribute('radius'));
    const l = num(cyl.getAttribute('length'));
    // ⚠ URDF の円柱は **Z 軸まわり**。three.js の CylinderGeometry は Y 軸まわり
    //   なので、X に -90° 回して寝かせる。ここを忘れると全部の円柱が倒れる。
    const g = new THREE.CylinderGeometry(r, r, l, 32);
    g.rotateX(Math.PI / 2);
    return g;
  }
  const sph = geo.querySelector('sphere');
  if (sph) return new THREE.SphereGeometry(num(sph.getAttribute('radius')), 24, 16);
  return null;
}

export async function loadUrdf(xmlText: string, opt: UrdfLoadOptions): Promise<UrdfRobot> {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`URDF の XML が壊れています: ${err.textContent?.slice(0, 120)}`);
  const robotEl = doc.querySelector('robot');
  if (!robotEl) throw new Error('<robot> が見つかりません');

  const links = new Map<string, THREE.Object3D>();
  const missing: string[] = [];
  let tri = 0;

  // robot 直下の名前付き material。visual からは `<material name="x"/>` と名前だけで参照できる。
  const named = new Map<string, { color: THREE.Color; opacity: number }>();
  for (const el of Array.from(robotEl.querySelectorAll(':scope > material'))) {
    const spec = materialSpec(el);
    const nm = el.getAttribute('name');
    if (nm && spec) named.set(nm, spec);
  }

  for (const linkEl of Array.from(robotEl.querySelectorAll(':scope > link'))) {
    const name = linkEl.getAttribute('name') || `link${links.size}`;
    const linkObj = new THREE.Object3D();
    linkObj.name = name;
    for (const vis of Array.from(linkEl.querySelectorAll(':scope > visual'))) {
      const geoEl = vis.querySelector('geometry');
      if (!geoEl) continue;
      let geom: THREE.BufferGeometry | null = null;
      let meshScale: THREE.Vector3 | null = null;
      const meshEl = geoEl.querySelector('mesh');
      if (meshEl) {
        const file = meshEl.getAttribute('filename') || '';
        geom = await opt.resolveMesh(file);
        if (!geom) { missing.push(file); continue; }
        meshScale = meshEl.hasAttribute('scale') ? vec3(meshEl.getAttribute('scale'), 1) : null;
      } else {
        geom = primitive(geoEl);
      }
      if (!geom) continue;
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const spec = visualMaterial(vis, named);
      const mat = opt.material ? opt.material(name)
        : new THREE.MeshStandardMaterial({
          color: spec ? spec.color : 0xbfc4cc, metalness: 0.05, roughness: 0.65, side: THREE.DoubleSide,
          transparent: !!spec && spec.opacity < 1, opacity: spec?.opacity ?? 1,
        });
      const mesh = new THREE.Mesh(geom, mat);
      mesh.name = `${name}/visual`;
      // ビューア側が「URDF が指定した色」へ戻したり、リンク単位で塗り分けたりするための控え。
      mesh.userData.link = name;
      mesh.userData.baseColor = (mat as THREE.MeshStandardMaterial).color?.getHex() ?? 0xbfc4cc;
      mesh.userData.baseOpacity = spec?.opacity ?? 1;
      applyOrigin(mesh, vis.querySelector('origin'));
      if (meshScale) mesh.scale.copy(meshScale);
      linkObj.add(mesh);
      const idx = geom.index ? geom.index.count : geom.attributes.position.count;
      tri += idx / 3;
    }
    links.set(name, linkObj);
  }

  const joints: UrdfJoint[] = [];
  const childOf = new Set<string>();
  for (const jEl of Array.from(robotEl.querySelectorAll(':scope > joint'))) {
    const name = jEl.getAttribute('name') || `joint${joints.length}`;
    const type = (jEl.getAttribute('type') || 'fixed') as JointType;
    const parent = jEl.querySelector('parent')?.getAttribute('link') || '';
    const child = jEl.querySelector('child')?.getAttribute('link') || '';
    const parentObj = links.get(parent);
    const childObj = links.get(child);
    if (!parentObj || !childObj) {
      console.warn(`URDF: 関節 ${name} の link が見つかりません (${parent} → ${child})`);
      continue;
    }
    const originNode = new THREE.Object3D();
    originNode.name = `${name}/origin`;
    applyOrigin(originNode, jEl.querySelector('origin'));
    const motion = new THREE.Object3D();
    motion.name = `${name}/motion`;
    originNode.add(motion);
    motion.add(childObj);
    parentObj.add(originNode);
    childOf.add(child);

    const axisEl = jEl.querySelector('axis');
    const axis = axisEl ? vec3(axisEl.getAttribute('xyz')) : new THREE.Vector3(1, 0, 0);
    if (axis.lengthSq() === 0) axis.set(1, 0, 0);
    axis.normalize();
    const limEl = jEl.querySelector('limit');
    // ⚠ continuous は limit に lower/upper を持たない。持たせないと
    //   スライダーの端が 0 になって動かせなくなるので ±π を入れる。
    const lower = type === 'continuous' ? -Math.PI : num(limEl?.getAttribute('lower'), 0);
    const upper = type === 'continuous' ? Math.PI : num(limEl?.getAttribute('upper'), 0);
    joints.push({ name, type, parent, child, axis, lower, upper, value: 0, motion });
  }

  const rootName = [...links.keys()].find(n => !childOf.has(n));
  if (!rootName) throw new Error('URDF: ルートの link が決まりません（閉ループの疑い）');
  const root = new THREE.Object3D();
  root.name = `${robotEl.getAttribute('name') || 'robot'}`;
  // ⚠ URDF は m、ビューアは mm
  root.scale.setScalar(1000);
  root.add(links.get(rootName)!);

  const robot: UrdfRobot = {
    name: robotEl.getAttribute('name') || 'robot',
    root, joints, links, missing, tri,
  };
  for (const j of joints) setJoint(j, 0);
  return robot;
}

/** 関節値を設定する（revolute/continuous は rad、prismatic は m） */
export function setJoint(j: UrdfJoint, value: number): void {
  const v = Number.isFinite(value) ? value : 0;
  j.value = v;
  if (j.type === 'revolute' || j.type === 'continuous') {
    j.motion.quaternion.setFromAxisAngle(j.axis, v);
    j.motion.position.set(0, 0, 0);
  } else if (j.type === 'prismatic') {
    j.motion.position.copy(j.axis).multiplyScalar(v);
    j.motion.quaternion.identity();
  }
  j.motion.updateMatrix();
}
