import { createJWT } from "../crypto/jwt.js";
import { encryptPayload } from "../crypto/encrypt.js";
import { generateHeaders } from "./generate.js";
/**
 * Send a push notification to a user.
 * @param vapidKeys - The VAPID keys to use for the request.
 * @param subscription - The PushSubscription to send the notification to.
 * @param email - The email address to use as the `sub` claim in the JWT. For example, `support@website.com`.
 * @param payload - The payload to send in the notification.
 * @param options - Options for encryption and additional headers. Defaults to AES128GCM if not specified.
 * @returns The response from the push service.
 * @throws If any of the keys are unable to be parsed.
 */
export async function sendPushNotification(vapidKeys, subscription, email, payload, options = { algorithm: "aes128gcm" }) {
    const jwt = await createJWT(vapidKeys.privateKey, new URL(subscription.endpoint), email);
    const { encrypted, salt, appServerPublicKey } = await encryptPayload(payload, subscription.keys, options);
    const headers = await generateHeaders(vapidKeys.publicKey, jwt, encrypted, {
        ...options,
        appServerPubKey: appServerPublicKey,
        salt,
    });
    const request = new Request(subscription.endpoint, {
        method: "POST",
        headers,
        body: encrypted,
    });
    return fetch(request);
}
