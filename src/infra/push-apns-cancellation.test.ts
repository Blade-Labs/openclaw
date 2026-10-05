import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import http2 from "node:http2";
import { describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import * as apnsHttp2 from "./push-apns-http2.js";
import { APNS_HTTP2_CANCEL_CODE } from "./push-apns-http2.js";
import { sendApnsBackgroundWake, sendApnsExecApprovalAlert } from "./push-apns.js";

const testAuthPrivateKey = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
}).privateKey.export({ format: "pem", type: "pkcs8" });

describe("APNs cancellation", () => {
  it("suppresses an approval after asynchronous HTTP/2 connection preparation", async () => {
    const request = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      end: vi.fn(() => {
        request.emit("response", { ":status": 200 });
        request.emit("end");
      }),
    });
    const session = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      destroy: vi.fn(),
      request: vi.fn(() => request),
    });
    session.destroy.mockImplementation(() => session.emit("close"));
    const started = createDeferred();
    const preparation = createDeferred<http2.ClientHttp2Session>();
    const connect = vi.spyOn(apnsHttp2, "connectApnsHttp2Session").mockImplementationOnce(() => {
      started.resolve();
      return preparation.promise;
    });
    let suppressed = false;
    try {
      const sending = sendApnsExecApprovalAlert({
        registration: {
          nodeId: "synthetic-ios-node",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "production",
          updatedAtMs: 1,
        },
        nodeId: "synthetic-ios-node",
        approvalId: "synthetic-approval",
        gatewayDeviceId: "synthetic-gateway",
        auth: { teamId: "synthetic-team", keyId: "synthetic-key", privateKey: testAuthPrivateKey },
        assertCurrent: () => {
          if (suppressed) {
            throw new Error("synthetic requester-only suppression");
          }
        },
      });
      await started.promise;
      suppressed = true;
      preparation.resolve(session as unknown as http2.ClientHttp2Session);
      await expect(sending).rejects.toThrow("synthetic requester-only suppression");
      expect(session.request).not.toHaveBeenCalled();
    } finally {
      preparation.resolve(session as unknown as http2.ClientHttp2Session);
      connect.mockRestore();
    }
  });

  it("cancels the active stream when pairing ownership is revoked", async () => {
    const requestEnded = createDeferred();
    const request = Object.assign(new EventEmitter(), {
      destroyed: false,
      setTimeout: vi.fn(),
      close: vi.fn(),
      end: vi.fn(() => requestEnded.resolve()),
    });
    request.close.mockImplementation(() => {
      request.destroyed = true;
      request.emit("close");
    });
    const session = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      destroy: vi.fn(),
      request: vi.fn(() => request),
    });
    session.close.mockImplementation(() => session.emit("close"));
    const connect = vi
      .spyOn(http2, "connect")
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);
    const controller = new AbortController();

    try {
      const sending = sendApnsBackgroundWake({
        registration: {
          nodeId: "ios-node-cancelled-stream",
          transport: "direct",
          token: "ABCD1234ABCD1234ABCD1234ABCD1234",
          topic: "ai.openclaw.ios",
          environment: "production",
          updatedAtMs: 1,
        },
        nodeId: "ios-node-cancelled-stream",
        wakeReason: "node.invoke",
        auth: {
          teamId: "TEAM123",
          keyId: "KEY123",
          privateKey: testAuthPrivateKey,
        },
        signal: controller.signal,
        isCurrent: vi.fn().mockResolvedValue(true),
      });
      await withTestTimeout(requestEnded.promise, 1_000, "APNs request.end was not called");
      expect(request.end).toHaveBeenCalledTimes(1);

      controller.abort(new Error("pairing removed"));

      await expect(sending).rejects.toThrow("pairing removed");
      expect(request.close).toHaveBeenCalledWith(APNS_HTTP2_CANCEL_CODE);
      expect(session.close).toHaveBeenCalledTimes(1);
      expect(session.destroy).not.toHaveBeenCalled();
    } finally {
      connect.mockRestore();
    }
  });
});
