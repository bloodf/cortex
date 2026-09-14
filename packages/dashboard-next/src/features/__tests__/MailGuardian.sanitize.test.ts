import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "@/features/MailGuardian";

describe("sanitizeHtml — XSS payloads", () => {
  it("strips <script> but keeps safe markup", () => {
    const out = sanitizeHtml("<script>alert(1)</script><p>safe</p>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toContain("<p>safe</p>");
  });

  it("strips onerror handler (or whole img)", () => {
    const out = sanitizeHtml("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("onerror");
    expect(out).not.toContain("alert(1)");
  });

  it("sanitizes javascript: URIs in href", () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert(1)");
  });

  it("strips style attributes", () => {
    const out = sanitizeHtml('<div style="background-image:url(javascript:alert(1))">x</div>');
    expect(out).not.toContain("style=");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("alert(1)");
  });

  it("strips form elements", () => {
    const out = sanitizeHtml("<form><input type=text></form>");
    expect(out).not.toContain("<form");
    expect(out).not.toContain("<input");
  });

  it("passes clean HTML through unchanged", () => {
    const clean = "<p>hello <b>world</b></p>";
    expect(sanitizeHtml(clean)).toBe(clean);
  });

  it("returns empty string for empty/null/undefined input", () => {
    expect(sanitizeHtml("")).toBe("");
    expect(sanitizeHtml(null)).toBe("");
    expect(sanitizeHtml(undefined)).toBe("");
  });

  it("blocks remote images, interactive controls, and hardens links", () => {
    const html = sanitizeHtml(
      '<a href="https://example.test">read more</a>' +
        '<img src="https://tracker.test/pixel.gif">' +
        '<form><input value="secret"><button>Send</button></form>' +
        "<select><option>One</option></select><textarea>notes</textarea>",
    );
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<textarea");
  });

  it("strips svg, iframe, object, embed, base, link, meta and data: URIs", () => {
    const html = sanitizeHtml(
      "<svg><script>alert(1)</script></svg>" +
        '<iframe src="https://evil.test"></iframe>' +
        '<object data="https://evil.test"></object>' +
        '<embed src="https://evil.test">' +
        '<base href="https://evil.test/">' +
        '<link rel="stylesheet" href="https://evil.test.css">' +
        '<meta http-equiv="refresh" content="0;url=https://evil.test">' +
        '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    );
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("<object");
    expect(html).not.toContain("<embed");
    expect(html).not.toContain("<base");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<meta");
    expect(html).not.toContain("data:text/html");
  });
});
