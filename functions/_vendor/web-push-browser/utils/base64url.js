/**
 * Convert a string or ArrayBuffer to a base64url encoded string
 * @param data - The data to encode.
 * @returns The base64url encoded string.
 */
export function toBase64Url(data) {
    const bytes = typeof data === "string"
        ? new TextEncoder().encode(data) // Convert string to Uint8Array
        : data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Convert bytes to string safely (avoiding call stack overflow)
    let binaryString = "";
    const chunkSize = 8192; // Process in chunks to avoid call stack limits
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binaryString += String.fromCharCode(...chunk);
    }
    const base64 = btoa(binaryString);
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
/**
 * Convert a base64url encoded string to an ArrayBuffer
 * @param base64 - The base64url encoded string.
 * @returns The ArrayBuffer.
 */
export function fromBase64Url(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const base64Padded = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64Padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}
