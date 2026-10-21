import { describe, it, expect } from "vitest";
import { isAllowedPushEndpoint } from "@/lib/push-endpoint";

describe("push endpoint allowlist", () => {
  it("accepts the major push services over https", () => {
    for (const u of [
      "https://fcm.googleapis.com/fcm/send/abc:APA91b",
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAA",
      "https://wns2-bl2p.notify.windows.com/w/?token=abc",
      "https://web.push.apple.com/QGxKQ",
      "https://us-east-1.push.apple.com/abc",
    ]) expect(isAllowedPushEndpoint(u), u).toBe(true);
  });
  it("rejects loopback, private, internal, http, IP, credentials, odd ports and unknown hosts", () => {
    for (const u of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://127.0.0.1/x", "https://localhost/x", "https://10.0.0.5/x", "https://169.254.169.254/latest",
      "https://[::1]/x", "https://metadata.google.internal/", "https://example.com/push",
      "https://fcm.googleapis.com.evil.example/x", "https://user:pw@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x",
      "https://push.invalid/sub-1", "ftp://fcm.googleapis.com/x", "not a url", "",
    ]) expect(isAllowedPushEndpoint(u), u).toBe(false);
  });
});
