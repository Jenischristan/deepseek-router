import fs from 'node:fs';

// DeepSeek web uses a WASM implementation of DeepSeekHashV1. The module has no
// imports, so it can be driven directly. Keeping the exact solver avoids having
// to guess the hash/target rules used by the site.
export class PowSolver {
  constructor(wasmPath) {
    const bytes = fs.readFileSync(wasmPath);
    const module = new WebAssembly.Module(bytes);
    const instance = new WebAssembly.Instance(module, {});
    const ex = instance.exports;

    if (
      !ex.memory ||
      typeof ex.wasm_solve !== 'function' ||
      typeof ex.__wbindgen_export_0 !== 'function'
    ) {
      throw new Error(`Invalid DeepSeek PoW wasm: ${wasmPath}`);
    }

    this.ex = ex;
  }

  _alloc(str) {
    const bytes = Buffer.from(str, 'utf8');
    const ptr = this.ex.__wbindgen_export_0(bytes.length, 1) >>> 0;
    new Uint8Array(this.ex.memory.buffer, ptr, bytes.length).set(bytes);
    return { ptr, len: bytes.length };
  }

  solve(challenge) {
    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const challengeStr = String(challenge.challenge);

    const c = this._alloc(challengeStr);
    const p = this._alloc(prefix);
    const ret = this.ex.__wbindgen_export_0(16, 8) >>> 0;

    this.ex.wasm_solve(
      ret,
      c.ptr,
      c.len,
      p.ptr,
      p.len,
      Number(challenge.difficulty),
    );

    // Re-create views: a memory grow invalidates old typed arrays.
    const status = new Int32Array(this.ex.memory.buffer, ret, 1)[0];
    const answer = new Float64Array(this.ex.memory.buffer, ret + 8, 1)[0];

    if (status !== 1 || !Number.isFinite(answer)) {
      throw new Error(
        `PoW solver found no answer (difficulty=${challenge.difficulty})`,
      );
    }

    return answer;
  }
}
