import { toBase64Url } from "../utils/base64url.js";
/**
 * Generate and sign a JWT token.
 *
 * To be used in the `Authorization` header of a POST request to a web Push API endpoint.
 * @param privateVapidKey - The private key to sign the JWT with.
 * @param endpoint - The URL of the web Push API endpoint.
 * @param email - The email address to use as the `sub` claim. For example, `support@website.com`.
 * @returns
 */
export async function createJWT(privateVapidKey, endpoint, email) {
    const aud = endpoint.origin;
    const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours from now
    const sub = `mailto:${email}`;
    return await signJWT({ alg: "ES256", typ: "JWT" }, {
        aud,
        exp,
        sub,
    }, privateVapidKey);
}
async function signJWT(header, payload, privateKey) {
    const encoder = new TextEncoder();
    // Encode header and payload
    const encodedHeader = toBase64Url(encoder.encode(JSON.stringify(header)));
    const encodedPayload = toBase64Url(encoder.encode(JSON.stringify(payload)));
    // Create the content to be signed
    const content = `${encodedHeader}.${encodedPayload}`;
    // Sign the content
    const signature = await crypto.subtle.sign({
        name: "ECDSA",
        hash: { name: "SHA-256" },
    }, privateKey, encoder.encode(content));
    // Convert the signature to base64url
    const encodedSignature = toBase64Url(signature);
    // Combine all parts to form the JWT
    return `${content}.${encodedSignature}`;
}
