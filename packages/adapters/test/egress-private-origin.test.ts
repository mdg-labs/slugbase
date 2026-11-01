import { describe, expect, it } from "vitest";
import { isOperatorPrivateAddress, parseAddress } from "../src/egress/address.ts";
import { HttpEgress } from "../src/index.ts";

// Q90: the addresses an operator's allowance for the AI endpoint lifts the refusal of, and what the option accepts.

const classed = (text: string): boolean => {
  const parsed = parseAddress(text);
  if (parsed === undefined) {
    throw new Error(`${text} is no address`);
  }
  return isOperatorPrivateAddress(parsed);
};

describe("the addresses the allowance covers", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.255.255",
    "100.64.0.1",
    "100.127.255.255",
    "::1",
    "fc00::1",
    "fd12:3456:789a::1",
    "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    "::ffff:10.0.0.1",
    "::ffff:127.0.0.1",
    "::ffff:a00:1",
    "::ffff:100.64.0.1",
  ])("covers %s", (address) => {
    expect(classed(address)).toBe(true);
  });

  it.each([
    "169.254.169.254",
    "169.254.0.1",
    "0.0.0.0",
    "0.1.2.3",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "192.0.2.1",
    "198.18.0.1",
    "192.0.0.1",
    "172.15.255.255",
    "172.32.0.1",
    "100.63.255.255",
    "100.128.0.1",
    "192.169.0.1",
    "11.0.0.1",
    "::",
    "fe80::1",
    "febf::1",
    "fbff::1",
    "fe00::1",
    "ff02::1",
    "2001:db8::1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "::ffff:0.0.0.0",
    "::ffff:224.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
  ])("does not cover %s", (address) => {
    expect(classed(address)).toBe(false);
  });

  it("does not cover a public address either, which needs no allowance", () => {
    expect(classed("8.8.8.8")).toBe(false);
    expect(classed("2606:4700::1111")).toBe(false);
  });
});

describe("the privateOrigin option", () => {
  it.each(["http://llm.lan:11434", "https://llm.example.com", "http://127.0.0.1:8080/", "http://[::1]:11434", "HTTP://LLM.Lan:80"])(
    "accepts the origin %s",
    (origin) => {
      expect(() => new HttpEgress({ nodeEnv: "production", privateOrigin: origin })).not.toThrow();
    },
  );

  it.each([
    "llm.lan",
    "llm.lan:11434",
    "ftp://llm.lan",
    "http://llm.lan/v1",
    "http://llm.lan?x=1",
    "http://llm.lan#x",
    "http://user:pw@llm.lan",
    "http://",
    "",
    "*",
  ])("refuses %j, which is not an http or https origin", (origin) => {
    expect(() => new HttpEgress({ nodeEnv: "production", privateOrigin: origin })).toThrow();
  });
});
