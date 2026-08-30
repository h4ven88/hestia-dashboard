import { fromBase64Url, toBase64Url } from "../utils/base64url.js";
/**
 * Generate a new pair of VAPID keys.
 * @returns A new pair of VAPID keys.
 */
export async function generateVapidKeys() {
    const { publicKey, privateKey } = await crypto.subtle.generateKey({
        name: "ECDSA",
        namedCurve: "P-256",
    }, true, ["sign", "verify"]);
    return { publicKey, privateKey };
}
/**
 * Serialize a pair of VAPID keys to a format that can be stored or transmitted.
 *
 * Public & private keys are exported in the RAW and PKCS8 formats, respectively.
 * @param keyPair - The keys to serialize.
 * @returns The serialized keys (in base64url format).
 */
export async function serializeVapidKeys(keyPair) {
    const publicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const privateKey = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
    return {
        publicKey: toBase64Url(publicKey),
        privateKey: toBase64Url(privateKey),
    };
}
/**
 * Deserialize a pair of VAPID keys from a serialized format.
 *
 * Public & private keys are imported from the RAW and PKCS8 formats, respectively.
 * @param keyPair - The serialized keys (in base64url format).
 * @returns The deserialized keys.
 */
export async function deserializeVapidKeys(keyPair) {
    const [publicKeyStr, privateKeyStr] = [
        keyPair.publicKey,
        keyPair.privateKey,
    ].map(fromBase64Url);
    const [publicKey, privateKey] = await Promise.all([
        crypto.subtle.importKey("raw", publicKeyStr, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]),
        crypto.subtle.importKey("pkcs8", privateKeyStr, { name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]),
    ]);
    return { publicKey, privateKey };
}
