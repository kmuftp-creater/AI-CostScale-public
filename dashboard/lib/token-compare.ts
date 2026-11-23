import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 共用 token 的恆定時間比對。先各自做 SHA-256 再比對固定 32 位元組的摘要，
 * 所以比對耗時與「兩個字串有幾個字元相同」、「長度是否相同」都無關。
 * 用 `!==` 比對 token 時，耗時會隨著前面相同的字元數變化，原理上可以被用來一個字元一個字元猜出 token。
 */
export function safeTokenEqual(got: string, expected: string): boolean {
  const a = createHash("sha256").update(got, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
