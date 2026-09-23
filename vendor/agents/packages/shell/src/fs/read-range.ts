/** Validate byte ranges before calling APIs whose slicing rules accept negatives. */
export function validateReadRange(offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw Object.assign(new RangeError("EINVAL: invalid byte range"), {
      code: "EINVAL"
    });
  }
}
