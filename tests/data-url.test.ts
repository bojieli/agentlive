import { expect, it } from "vitest";
import { decodeArtifactDataUrl } from "../packages/adapters/src/data-url.js";

it("decodes literal plus, percent-encoded UTF-8, default media type and binary octets", () => {
  expect(decodeArtifactDataUrl("data:,a+b%20c")?.bytes.toString()).toBe(
    "a+b c",
  );
  const text = decodeArtifactDataUrl("data:;charset=utf-8,%E2%98%83");
  expect(text?.bytes.toString()).toBe("☃");
  expect(text?.mediaType).toBe("text/plain");
  expect(text?.text).toBe(true);
  const binary = decodeArtifactDataUrl(
    "data:application/octet-stream,%00%FF%80",
  );
  expect([...binary!.bytes]).toEqual([0, 255, 128]);
  expect(binary?.text).toBe(false);
});
it("accepts charset-qualified canonical base64 and escaped base64 characters", () => {
  expect(
    decodeArtifactDataUrl(
      "data:text/plain;charset=UTF-8;base64,SGk%3D",
    )?.bytes.toString(),
  ).toBe("Hi");
  expect(
    decodeArtifactDataUrl("data:application/octet-stream;base64,%2Bw%3D%3D")
      ?.bytes[0],
  ).toBe(251);
});
it.each([
  "data:text/plain,%",
  "data:text/plain,%0",
  "data:text/plain,%GG",
  "data:text/plain,raw space",
  "data:text/plain,☃",
  "data:text/plain,#fragment",
  "data:text/plain,%FF",
  "data:text/plain;charset=us-ascii,%C3%A9",
  "data:text/plain;charset=iso-8859-1,%E9",
  "data:text/plain;charset=utf-8;charset=utf-8,hello",
  "data:text/plain;unknown=value,hello",
  "data:text/plain;base64,SGk",
  "data:text/plain;base64,SGm=",
  "data:text/plain;base64,%FF",
  "data:text/plain;base64;charset=utf-8,SGk=",
  "data:text/plain",
])("rejects malformed or unsupported data without throwing (%s)", (url) => {
  expect(decodeArtifactDataUrl(url)).toBeUndefined();
});
it("rejects mismatched media types and limits encoded allocation", () => {
  expect(
    decodeArtifactDataUrl("data:text/plain,hello", "image/png"),
  ).toBeUndefined();
  expect(
    decodeArtifactDataUrl(
      "data:text/plain," + "a".repeat(32 * 1024 * 1024 + 1),
    ),
  ).toBeUndefined();
});
