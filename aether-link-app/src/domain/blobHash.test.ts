import { describe, expect, it } from "vitest";
import { sha256BlobHex } from "./blobHash";

describe("sha256BlobHex", () => {
  it("hashes an empty blob", async () => {
    await expect(sha256BlobHex(new Blob())).resolves.toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("hashes incrementally without reading the entire blob at once", async () => {
    const blob = new Blob(["abc", "def", "ghi"]);
    const sliceSizes: number[] = [];
    const originalSlice = blob.slice.bind(blob);
    blob.slice = ((start?: number, end?: number, contentType?: string) => {
      const slice = originalSlice(start, end, contentType);
      sliceSizes.push(slice.size);
      return slice;
    }) as Blob["slice"];

    await expect(sha256BlobHex(blob, 3)).resolves.toBe(
      "19cc02f26df43cc571bc9ed7b0c4d29224a3ec229529221725ef76d021c8326f",
    );
    expect(sliceSizes).toEqual([3, 3, 3]);
  });

  it("rejects invalid chunk sizes", async () => {
    await expect(sha256BlobHex(new Blob(["a"]), 0)).rejects.toThrow("positive safe integer");
  });
});
