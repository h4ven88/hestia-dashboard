const importHMACKey = async (keyData) => crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const signHMAC = async (key, data) => new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
export async function hkdfExtract(salt, ikm) {
    const key = await importHMACKey(salt);
    return await signHMAC(key, ikm);
}
export async function hkdfExpand(prk, info, length) {
    const key = await importHMACKey(prk);
    const result = new Uint8Array(length);
    let t = new Uint8Array(0);
    const counter = new Uint8Array([0]);
    for (let i = 0; i < length; i += 32) {
        counter[0]++;
        t = await signHMAC(key, concat(t, info, counter));
        result.set(t.subarray(0, Math.min(32, length - i)), i);
    }
    return result.slice(0, length);
}
export function concat(...arrays) {
    const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
        result.set(arr, offset);
        offset += arr.length;
    }
    return result;
}
// Helper function for aesgcm info creation
export function createHeader(opts) {
    const encoder = new TextEncoder();
    if (opts.algorithm === "aesgcm") {
        return concat(encoder.encode(`Content-Encoding: ${opts.algorithm}\0`), encoder.encode("P-256\0"), new Uint8Array(new Uint16Array([opts.clientPublicKey.byteLength]).buffer), new Uint8Array(opts.clientPublicKey), new Uint8Array(new Uint16Array([opts.localPublicKey.byteLength]).buffer), new Uint8Array(opts.localPublicKey));
    }
    if (opts.algorithm === "aes128gcm") {
        return concat(new Uint8Array(opts.salt), new Uint8Array(new Uint32Array([4096]).buffer), // 4 bytes for record size
        new Uint8Array([opts.localPublicKey.byteLength]), // 1 byte for key length
        new Uint8Array(opts.localPublicKey));
    }
    throw new Error("Invalid algorithm");
}
export function createNonceInfo(opts) {
    const encoder = new TextEncoder();
    if (opts.algorithm === "aesgcm") {
        return concat(encoder.encode("Content-Encoding: nonce\0"), encoder.encode("P-256\0"), new Uint8Array(new Uint16Array([opts.clientPublicKey.byteLength]).buffer), new Uint8Array(opts.clientPublicKey), new Uint8Array(new Uint16Array([opts.localPublicKey.byteLength]).buffer), new Uint8Array(opts.localPublicKey));
    }
    if (opts.algorithm === "aes128gcm") {
        return encoder.encode("Content-Encoding: nonce\0");
    }
    throw new Error("Invalid algorithm");
}
export function createCEKInfo(algorithm) {
    const encoder = new TextEncoder();
    if (algorithm === "aesgcm") {
        return encoder.encode("Content-Encoding: aesgcm\0");
    }
    if (algorithm === "aes128gcm") {
        return encoder.encode("Content-Encoding: aes128gcm\0");
    }
    throw new Error("Invalid algorithm");
}
