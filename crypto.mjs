/**
 * 词库加密 / 解密（AES-256-GCM + PBKDF2）
 *
 * 为什么需要：GitHub 免费账号做不出私有站点（私有仓库开不了 Pages；就算付费，
 * Pages 站点本身仍是公开的，只有企业版能设私有）。所以换个思路 ——
 * 把词库加密后再上传，站点地址公开，但没有密码的人只会看到一个密码框，
 * 拿不到任何词条。达到「只有我能用」的效果。
 *
 * 设计取舍：
 *   · 用 AES-GCM 而不是自己搓的异或 —— GCM 自带完整性校验，
 *     密码错或文件被改动都会解密失败，不会吐出一堆乱码当词库用。
 *   · PBKDF2 迭代 20 万次 —— 密码是短口令，必须加计算成本抵抗暴力破解。
 *   · 留在前端的派生密钥存 localStorage —— 下次打开不用重输密码。
 *     存在本机的密钥被拿到就等于密码被拿到，但这本来就是"单机单人"的工具，
 *     威胁模型是"别人猜到网址也进不来"，不是"别人拿到我的电脑还进不来"。
 *
 * 这个文件在 Node 和浏览器里都能跑（两边都有 globalThis.crypto.subtle），
 * 所以加密在构建脚本里做、解密在前端做，用的是同一份代码。
 */

const ALGO = 'AES-GCM';
const KEY_ALGO = { name: 'PBKDF2', hash: 'SHA-256' };
const ITER = 200000;
const SALT_LEN = 16;
const IV_LEN = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------- base64

export function toB64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  // 浏览器有 btoa；Node 也有（全局）。两边都可用。
  return btoa(s);
}

export function fromB64(str) {
  const s = atob(str);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

// ---------------------------------------------------------------- 密钥派生

/**
 * 从密码派生 AES 密钥。
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKey(password, salt) {
  if (!password) throw new Error('密码为空');
  const base = await crypto.subtle.importKey('raw', enc.encode(password), KEY_ALGO, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' },
    base,
    { name: ALGO, length: 256 },
    // 导出能力不需要，保持 false（密钥不出内存）
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * 加密一个 JSON 对象。
 * 返回可直接写进文件的紧凑结构。
 */
export async function encryptJSON(obj, password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const key = await deriveKey(password, salt);
  const plain = enc.encode(JSON.stringify(obj));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: ALGO, iv }, key, plain));
  return {
    v: 1,
    alg: 'AES-256-GCM',
    kdf: `PBKDF2-SHA256/${ITER}`,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

/**
 * 解密。密码错或数据被改动会抛错（GCM 的完整性校验）。
 * 抛出的信息刻意不区分"密码错"和"数据坏了"，避免给试探者额外线索。
 */
export async function decryptJSON(bundle, password) {
  if (!bundle || bundle.v !== 1 || !bundle.salt || !bundle.iv || !bundle.ct) {
    throw new Error('格式不对');
  }
  const salt = fromB64(bundle.salt);
  const iv = fromB64(bundle.iv);
  const ct = fromB64(bundle.ct);
  const key = await deriveKey(password, salt);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: ALGO, iv }, key, ct);
  } catch {
    // 不要把底层错误抛出去（可能是 "operation failed" 之类），统一成一句
    throw new Error('密码不对');
  }
  return JSON.parse(dec.decode(plain));
}
