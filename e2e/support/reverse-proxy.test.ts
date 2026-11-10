import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import proxyConfig from "../reverse-proxy.config.ts";
import { caddyConfig, fencedBlocks, GUIDE, guideConfigs, nginxConfig, proxyImage, remainingOf, replaceOnce, type Ports } from "./reverse-proxy.ts";

const PORTS: Ports = { tls: 24443, http: 24080, upstream: 23000 };
const guide = readFileSync(GUIDE, "utf8");

void describe("the fenced blocks of a Markdown text", () => {
  void it("are listed in order with their info word and their body", () => {
    assert.deepEqual(fencedBlocks("text\n```nginx\na\n  b\n```\nmore\n```\nplain\n```\n"), [
      { info: "nginx", body: "a\n  b\n" },
      { info: "", body: "plain\n" },
    ]);
  });

  void it("refuse a block that is not closed", () => {
    assert.throws(() => fencedBlocks("```sh\nls\n"), /not closed/);
  });
});

void describe("the configurations of docs/self-hosting/reverse-proxy.md", () => {
  const configs = guideConfigs(guide);

  void it("are the complete nginx file and the complete Caddyfile, and not the snippets that sit beside them", () => {
    assert.match(configs.nginx, /^# The SlugBase server on this machine/);
    assert.ok(configs.nginx.includes("upstream slugbase {") && configs.nginx.includes("proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;"));
    assert.ok(configs.caddy.includes("reverse_proxy 127.0.0.1:3000") && configs.caddy.includes("links.example.com {"));
    assert.ok(configs.caddyGlobal.includes("trusted_proxies") && !configs.caddyGlobal.includes("reverse_proxy"));
  });

  void it("name one hop for one proxy and the certificate the file loads", () => {
    assert.equal(configs.hops, 1);
    assert.equal(configs.nginxCertificate, "/etc/ssl/slugbase/fullchain.pem");
    assert.equal(configs.nginxCertificateKey, "/etc/ssl/slugbase/privkey.pem");
  });

  void it("are told apart by what they hold, and a guide with two of one kind is refused", () => {
    const twice = `${guide}\n\`\`\`nginx\nupstream slugbase {}\n\`\`\`\n`;
    assert.throws(() => guideConfigs(twice), /2 `nginx` blocks/);
    assert.throws(() => guideConfigs(guide.replace("upstream slugbase", "upstream elsewhere")), /0 `nginx` blocks/);
  });

  void it("run with this host's ports, and nothing else of the nginx file changes", () => {
    const run = nginxConfig(configs.nginx, PORTS);
    assert.ok(run.includes("server 127.0.0.1:23000;"));
    assert.ok(run.includes("listen 127.0.0.1:24080;") && run.includes("listen 127.0.0.1:24443 ssl;"));
    assert.ok(!run.includes("[::]"));
    const unchanged = (text: string): string[] => text.split("\n").filter((line) => !/server 127\.0\.0\.1|listen /.test(line));
    assert.deepEqual(unchanged(run), unchanged(configs.nginx).filter((line) => !/^\s*listen /.test(line)));
  });

  void it("run with this host's ports, and the Caddyfile keeps its own body and proxies to the server", () => {
    const run = caddyConfig(configs.caddy, PORTS);
    assert.match(run, /^\{\n\tadmin off\n\thttp_port 24080\n\thttps_port 24443\n\}\n\n/);
    assert.ok(run.includes("127.0.0.1 {") && run.includes("reverse_proxy 127.0.0.1:23000") && run.includes("max_size 6MiB"));
    assert.ok(!run.includes("links.example.com {"));
  });

  void it("fail the drill when a line that is changed for the host is not in the guide any more", () => {
    assert.throws(() => nginxConfig(configs.nginx.replace("server 127.0.0.1:3000;", "server 127.0.0.1:4000;"), PORTS), /'server 127.0.0.1:3000;' 0 times/);
    assert.throws(() => caddyConfig(configs.caddy.replace("reverse_proxy 127.0.0.1:3000", "reverse_proxy slugbase:3000"), PORTS), /0 times/);
    assert.throws(() => replaceOnce("a a", "a", "b"), /2 times/);
  });
});

void describe("the images of the proxies", () => {
  void it("are named by a tag and a sha256 digest in e2e/compose.proxy.yml", () => {
    for (const service of ["nginx", "caddy"] as const) {
      assert.match(proxyImage(service), new RegExp(`^${service}:[0-9][^@]*@sha256:[0-9a-f]{64}$`));
    }
  });

  void it("are refused when the file names one by a tag alone, or does not name it", () => {
    assert.throws(() => proxyImage("nginx", "services:\n  nginx:\n    image: nginx:1.29\n"), /sha256 digest/);
    assert.throws(() => proxyImage("caddy", "services:\n  nginx:\n    image: nginx:1.29@sha256:" + "a".repeat(64) + "\n"), /caddy/);
  });
});

void describe("the RateLimit header", () => {
  void it("gives the tokens left in the named bucket", () => {
    const headers = { ratelimit: '"read";r=1199;t=1, "login";r=9;t=6, "login:email";r=19;t=180' };
    assert.equal(remainingOf(headers, "login"), 9);
    assert.equal(remainingOf(headers, "read"), 1199);
    assert.equal(remainingOf(headers, "login:email"), 19);
    assert.equal(remainingOf(headers, "write"), undefined);
    assert.equal(remainingOf({}, "login"), undefined);
  });
});

void describe("the configuration of the reverse proxy drill", () => {
  void it("gives the stack's start and every proxy a bound of their own", () => {
    assert.ok((proxyConfig.timeout ?? 0) >= 5 * 60_000);
    assert.equal(proxyConfig.workers, 1);
  });
});
