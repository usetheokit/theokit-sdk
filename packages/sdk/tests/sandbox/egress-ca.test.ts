import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";

import { EgressCa } from "../../src/sandbox/egress-ca.js";

describe("EgressCa", () => {
  it("issues leaf certificates that chain to the CA and name the host", () => {
    const ca = new EgressCa();
    const root = new X509Certificate(ca.certPem);
    expect(root.ca).toBe(true);
    for (const host of ["api.example.com", "127.0.0.1", "::1"]) {
      const leaf = new X509Certificate(ca.issue(host).cert);
      expect(leaf.verify(root.publicKey)).toBe(true);
      expect(leaf.checkIssued(root)).toBe(true);
      expect(
        host.includes(":") ? leaf.checkIP("::1") : (leaf.checkHost(host) ?? leaf.checkIP(host)),
      ).toBeTruthy();
    }
    expect(
      new X509Certificate(ca.issue("other.example.com").cert).checkHost("api.example.com"),
    ).toBeUndefined();
  });

  it("refuses to issue new certificates after destroy", () => {
    const ca = new EgressCa();
    ca.destroy();
    expect(() => ca.issue("a.example.com")).toThrow(/destroyed/);
  });
});
