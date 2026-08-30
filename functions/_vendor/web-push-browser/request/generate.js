import { toBase64Url } from "../utils/base64url.js";
/**
 * Generate the headers for a Web Push request.
 * @param publicVapidKey - The public VAPID key.
 * @param jwt - The signed JWT token.
 * @param encryptedPayload - The encrypted payload.
 * @param options - Options for encryption and additional headers. Defaults to AES128GCM if not specified.
 * @returns The generated headers.
 */
export async function generateHeaders(publicVapidKey, jwt, encryptedPayload, options = { algorithm: "aes128gcm" }) {
    const exportedPubKey = await crypto.subtle.exportKey("raw", publicVapidKey);
    const encodedPubKey = toBase64Url(exportedPubKey);
    const headers = new Headers();
    headers.append("Content-Type", "application/octet-stream");
    headers.append("Content-Length", encryptedPayload.byteLength.toString());
    headers.append("TTL", Math.floor(options.ttl ?? 86400).toString());
    if (options.urgency) {
        headers.append("Urgency", options.urgency);
    }
    if (options.algorithm === "aesgcm") {
        const exportedLocalPubKey = await crypto.subtle.exportKey("raw", options.appServerPubKey);
        const encodedLocalPubKey = toBase64Url(exportedLocalPubKey);
        headers.append("Authorization", `Bearer ${jwt}`);
        headers.append("Content-Encoding", "aesgcm");
        // On Microsoft Edge servers, this doesn't work, despite being documented in the spec
        // headers.append("Crypto-Key", `p256ecdsa=${encodedPubKey}`);
        // headers.append("Crypto-Key", `dh=${encodedLocalPubKey}`);
        headers.append("Crypto-Key", `p256ecdsa=${encodedPubKey};dh=${encodedLocalPubKey}`);
        headers.append("Encryption", `salt=${toBase64Url(options.salt)}`);
    }
    else {
        headers.append("Authorization", `vapid t=${jwt}, k=${encodedPubKey}`);
        headers.append("Content-Encoding", "aes128gcm");
    }
    return headers;
}
