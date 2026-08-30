import { fromBase64Url, toBase64Url } from "../utils/base64url.js";
import { concat, createCEKInfo, createHeader, createNonceInfo, hkdfExpand, hkdfExtract, } from "./helpers.js";
// Here's an explanation of each variable needed for encryption, from the RFC:
// https://datatracker.ietf.org/doc/html/draft-ietf-webpush-encryption-08#section-3.4
/**
 * Encrypt a plaintext payload using the keys provided by the PushSubscription.
 * @param payload - The plaintext payload to encrypt.
 * @param keys - The keys from the PushSubscription.
 * @param options - Options for encryption. Defaults to AES128GCM if not specified.
 */
export async function encryptPayload(payload, keys, options) {
    const encoder = new TextEncoder();
    // Step 1: Gather the necessary keys
    const userAgentPublicKey = typeof keys.p256dh === "string" ? fromBase64Url(keys.p256dh) : keys.p256dh;
    const authSecret = typeof keys.auth === "string" ? fromBase64Url(keys.auth) : keys.auth;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    // Step 2: Generate a new ECDH key pair
    const keyPair = options.appServerKeyPair ??
        (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
    const localPublicKey = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    // Step 3: Perform ECDH to get the shared secret
    const userAgentPublicKeyObject = await crypto.subtle.importKey("raw", userAgentPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
    const sharedSecret = await crypto.subtle.deriveBits({ name: "ECDH", public: userAgentPublicKeyObject }, keyPair.privateKey, 256);
    // Step 4: Derive the PRK
    const prk = await hkdfExtract(new Uint8Array(authSecret), new Uint8Array(sharedSecret));
    // Step 5: Create the info string and derive the IKM
    let keyInfo;
    if (options.algorithm === "aes128gcm") {
        keyInfo = concat(encoder.encode("WebPush: info\0"), new Uint8Array(userAgentPublicKey), new Uint8Array(localPublicKey));
    }
    else {
        keyInfo = concat(encoder.encode("Content-Encoding: auth\0"), new Uint8Array(0));
    }
    const ikm = await hkdfExpand(prk, keyInfo, 32);
    // Step 6: Derive the Content Encryption Key and nonce
    const cekInfo = createCEKInfo(options.algorithm);
    const nonceInfo = createNonceInfo({
        algorithm: options.algorithm,
        clientPublicKey: userAgentPublicKey,
        localPublicKey,
    });
    const prk2 = await hkdfExtract(salt, ikm);
    const cek = await hkdfExpand(prk2, cekInfo, 16);
    const nonce = await hkdfExpand(prk2, nonceInfo, 12);
    // Step 7: Encrypt the payload
    const paddedPayload = concat(encoder.encode(payload), new Uint8Array([2]));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]), paddedPayload);
    // Step 8: Assemble the encrypted payload with correct header
    const header = createHeader({
        algorithm: options.algorithm,
        clientPublicKey: userAgentPublicKey,
        localPublicKey,
        salt,
    });
    // Ensure that the ciphertext length doesn't exceed the record size
    if (ciphertext.byteLength > 4096 - 16) {
        // 16 is for auth tag
        throw new Error("Payload too large for single record");
    }
    const encryptedPayload = concat(header, new Uint8Array(ciphertext));
    return {
        encrypted: encryptedPayload,
        salt,
        appServerPublicKey: keyPair.publicKey,
        sharedSecret,
        prk,
        ikm,
        cek,
        nonce,
    };
}
