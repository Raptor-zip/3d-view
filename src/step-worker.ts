// STEP→色付きGLB 変換の専用ワーカー。
// メインスレッドで回すとUI（スピナー・進捗表示・操作）が変換中ずっと固まるため、
// OCCT(wasm)はこのワーカーに常駐させる。複数STEPは複数ワーカーで並行変換できる。
import { loadOCC, occHeapBytes, stepToGlb } from './step-occ';

export interface StepWorkerRequest {
  type: 'warmup' | 'convert';
  id?: number;
  bytes?: ArrayBuffer;
}

// tsconfig は DOM lib 前提なので、webworker lib を混ぜず必要な形だけを与える。
const ctx = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<StepWorkerRequest>)=> void) | null;
};

ctx.onmessage = async (event)=>{
  const { type, id, bytes } = event.data;
  if(type === 'warmup'){
    try { await loadOCC(); ctx.postMessage({ type:'warm' }); }
    catch(error){ ctx.postMessage({ type:'warmFailed', message:(error as Error).message }); }
    return;
  }
  if(type !== 'convert' || id === undefined || !bytes) return;
  try {
    // 途中経過は常に作る。作るコストは「先頭数部品のGLB書き出し」だけ（重いモデルで0.1〜1.5秒）で、
    // 変換中のワーカーは新しいメッセージを受け取れない＝「今から欲しい」と後で頼めないため。
    const glb = await stepToGlb(
      new Uint8Array(bytes),
      p=> ctx.postMessage({ id, type:'progress', ...p }),
      // 途中経過（転送済み部品だけのGLB）。所有権ごと渡す。
      (preview, info)=> ctx.postMessage({ id, type:'preview', glb:preview, ...info }, [preview]),
    );
    // heapBytes は「このワーカーを使い回すか作り直すか」の判断材料（wasmヒープは縮まない）。
    ctx.postMessage({ id, type:'done', glb, heapBytes:occHeapBytes() }, [glb]);
  } catch(error){
    ctx.postMessage({ id, type:'error', message:(error as Error).message || String(error), heapBytes:occHeapBytes() });
  }
};
